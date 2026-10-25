import { randomUUID } from 'node:crypto';
import { Types, trusted, type ClientSession } from 'mongoose';
import type { AppConfig } from '../../config/env.js';
import type { Principal } from '../auth/auth.types.js';
import { FileModel } from '../files/file.model.js';
import { ImportModel, ImportRowModel } from './import.models.js';
import { CommercialSettingsModel } from '../leads/commercial.models.js';
import { CommercialAccess } from '../leads/commercial-access.js';
import { OrganizationAccess } from '../../shared/services/organization-access.js';
import { S3CommercialStorage, type CommercialStorage } from './commercial-storage.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
import { AppError } from '../../shared/errors/app-error.js';
import { RoleModel } from '../roles/role.model.js';
import { UserModel } from '../users/user.model.js';
import { BranchModel } from '../branches/branch.model.js';
import { literalPrefix } from '../../shared/utils/query.js';
export const storedFileFields = '+bucket +objectKey +checksumSHA256 +versionId';
export interface ImportCreate { fileId: string; branchId: string; columnMapping: Record<string, string> }
export interface ImportQuery { page: number; limit: number; sortOrder: 'asc' | 'desc'; branchId?: string; status?: string }
export function persistedPrincipal(actor: Principal) { return { userId: actor.userId, roleId: actor.roleId, sessionId: actor.sessionId, branchId: actor.branchId, authVersion: actor.authVersion }; }
export class ImportService {
  private readonly access = new OrganizationAccess(); private readonly commercial = new CommercialAccess();
  readonly storage: CommercialStorage;
  constructor(private readonly config: AppConfig, storage?: CommercialStorage) { this.storage = storage ?? new S3CommercialStorage(config); }
  async withLabels<T extends { createdBy: Types.ObjectId; branchId: Types.ObjectId; fileId: Types.ObjectId; assignedTo?: Types.ObjectId | null | undefined }>(jobs: T[], session?: ClientSession) {
    if (!jobs.length) return [];
    const ids = (values: (Types.ObjectId | null | undefined)[]) => [...new Set(values.filter((id): id is Types.ObjectId => Boolean(id)).map((id) => id.toHexString()))].map((id) => new Types.ObjectId(id));
    // Resolve only references on already-authorized imports, with minimal public labels.
    // Keep session-bound reads sequential: MongoDB transactions share one session.
    const users = await UserModel.find({ _id: trusted({ $in: ids(jobs.flatMap((job) => [job.createdBy, job.assignedTo])) }) }).select('_id firstName lastName employeeCode').session(session ?? null).lean();
    const branches = await BranchModel.find({ _id: trusted({ $in: ids(jobs.map((job) => job.branchId)) }) }).select('_id branchName branchCode').session(session ?? null).lean();
    const files = await FileModel.find({ _id: trusted({ $in: ids(jobs.map((job) => job.fileId)) }) }).select('_id filename createdAt').session(session ?? null).lean();
    const people = new Map(users.map((user) => [user._id.toHexString(), user]));
    const offices = new Map(branches.map((branch) => [branch._id.toHexString(), branch]));
    const uploads = new Map(files.map((file) => [file._id.toHexString(), file]));
    return jobs.map((job) => {
      const creator = people.get(job.createdBy.toHexString());
      const assignee = job.assignedTo ? people.get(job.assignedTo.toHexString()) : undefined;
      const branch = offices.get(job.branchId.toHexString());
      const file = uploads.get(job.fileId.toHexString());
      return { ...job, createdByName: creator ? `${creator.firstName} ${creator.lastName}`.trim() : null, createdByCode: creator?.employeeCode ?? null,
        assignedToName: assignee ? `${assignee.firstName} ${assignee.lastName}`.trim() : null, assignedToCode: assignee?.employeeCode ?? null,
        branchName: branch?.branchName ?? null, branchCode: branch?.branchCode ?? null,
        fileName: file ? file.filename || `Contact import CSV (${file.createdAt.toISOString().slice(0, 10)})` : null };
    });
  }
  async upload(actor: Principal, input: { filename: string; size: number; checksumSHA256: string }, context: AuditContext) {
    if (!this.config.s3Bucket || !this.config.awsRegion) throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Private CSV storage is not configured');
    const photo = { bucket: this.config.s3Bucket, objectKey: `sunvika/imports/${actor.userId.toHexString()}/${randomUUID()}.csv`, contentType: 'text/csv' as const, size: input.size, checksumSHA256: input.checksumSHA256 };
    const upload = await this.storage.upload(photo);
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'imports:create', session); this.commercial.authorization.require(current, 'leads:import'); this.commercial.authorization.require(current, 'files:upload');
      if (await FileModel.countDocuments({ ownerId: current.userId, status: trusted({ $in: ['PENDING', 'READY'] }) }).session(session) >= 20) throw new AppError(429, 'UPLOAD_LIMIT', 'Outstanding upload limit reached');
      const expiresAt = new Date(Date.now() + 300000); const [file] = await FileModel.create([{ ...photo, filename: input.filename, ownerId: current.userId, purpose: 'CUSTOMER_IMPORT', expiresAt }], { session });
      if (!file) throw new Error('CSV upload insertion failed'); await audit(session, context, 'CSV_UPLOAD_REQUESTED', current.userId, 'file', file._id);
      return { fileId: file._id, expiresAt, upload: { method: 'POST', ...upload } };
    });
  }
  async confirmUpload(actor: Principal, id: Types.ObjectId, context: AuditContext) {
    const file = await FileModel.findOne({ _id: id, ownerId: actor.userId, purpose: 'CUSTOMER_IMPORT', status: 'PENDING', expiresAt: trusted({ $gt: new Date() }) }).select(storedFileFields).lean();
    if (!file) throw new AppError(404, 'NOT_FOUND', 'Pending CSV upload not found');
    const versionId = await this.storage.verifyCsv(file);
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'imports:create', session); this.commercial.authorization.require(current, 'leads:import'); this.commercial.authorization.require(current, 'files:upload');
      const ready = await FileModel.findOneAndUpdate({ _id: id, ownerId: current.userId, status: 'PENDING', expiresAt: trusted({ $gt: new Date() }) },
        { $set: { status: 'READY', versionId, confirmedAt: new Date() } }, { session, returnDocument: 'after' }).lean();
      if (!ready) throw new AppError(409, 'CONFLICT', 'Upload expired or already confirmed');
      await audit(session, context, 'FILE_UPLOADED', current.userId, 'file', id, { purpose: 'CUSTOMER_IMPORT' }); return ready;
    });
  }
  async create(actor: Principal, input: ImportCreate, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'imports:create', session); const branchId = new Types.ObjectId(input.branchId);
      await this.commercial.importBranch(current, 'imports:create', branchId, session); await this.commercial.importBranch(current, 'leads:import', branchId, session);
      const settings = await CommercialSettingsModel.findById('customers').session(session).lean();
      if (!settings) throw new AppError(503, 'COMMERCIAL_NOT_INITIALIZED', 'Run the commercial setup migration');
      const id = new Types.ObjectId();
      const file = await FileModel.findOneAndUpdate({ _id: new Types.ObjectId(input.fileId), ownerId: current.userId, purpose: 'CUSTOMER_IMPORT', status: 'READY', expiresAt: trusted({ $gt: new Date() }) },
        { $set: { status: 'ATTACHED', importId: id } }, { session, returnDocument: 'after' }).lean();
      if (!file) throw new AppError(400, 'INVALID_CSV_FILE', 'A fresh confirmed CSV upload owned by you is required');
      const [job] = await ImportModel.create([{ _id: id, createdBy: current.userId, branchId, principal: persistedPrincipal(current), fileId: file._id,
        columnMapping: input.columnMapping, duplicateScope: settings.duplicateScope, requestId: context.requestId, expiresAt: new Date(Date.now() + 604800000) }], { session });
      if (!job) throw new Error('Import insertion failed');
      await audit(session, context, 'CSV_IMPORT_QUEUED', current.userId, 'csv_import', id, { branchId: input.branchId });
      const created = await ImportModel.findById(id).session(session).lean();
      return created ? (await this.withLabels([created], session))[0] : null;
    });
  }
  async scope(actor: Principal, action: 'imports:read' | 'imports:confirm', session?: ClientSession) {
    const predicate = await this.commercial.scopes.predicate(actor, action, { ownerField: 'createdBy', hierarchyField: 'createdBy', branchField: 'branchId' }, session);
    // Import creators retain access to their own job; branch eligibility is rechecked for rows/confirmation/worker publication.
    return { $or: [predicate, { createdBy: actor.userId }] };
  }
  async list(actor: Principal, query: ImportQuery) {
    const filter: Record<string, unknown> = { $and: [await this.scope(actor, 'imports:read'), { ...(query.branchId ? { branchId: new Types.ObjectId(query.branchId) } : {}), ...(query.status ? { status: query.status } : {}) }] };
    const [data, total] = await Promise.all([ImportModel.find(filter).sort({ createdAt: query.sortOrder === 'asc' ? 1 : -1, _id: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(), ImportModel.countDocuments(filter)]);
    return { data: await this.withLabels(data), total };
  }
  async get(actor: Principal, id: Types.ObjectId, session?: ClientSession) {
    const job = await ImportModel.findOne({ $and: [{ _id: id }, await this.scope(actor, 'imports:read', session)] }).session(session ?? null).lean();
    if (!job) throw new AppError(404, 'NOT_FOUND', 'Import not found');
    const labeled = (await this.withLabels([job], session))[0];
    if (!labeled) throw new Error('Import label resolution failed');
    return labeled;
  }
  async rows(actor: Principal, id: Types.ObjectId, query: { page: number; limit: number; status?: string }) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'imports:read', session); const job = await this.get(current, id, session);
      await this.commercial.importBranch(current, 'imports:read', job.branchId, session);
      if (['QUEUED_VALIDATION', 'VALIDATING'].includes(job.status)) throw new AppError(409, 'PREVIEW_NOT_READY', 'Contact validation has not finished. The preview will become available after import processing completes.');
      if (job.status === 'FAILED') throw new AppError(409, 'PREVIEW_UNAVAILABLE', 'Import processing failed. Check the import status and error before uploading a corrected file.');
      const filter: Record<string, unknown> = { importId: id, ...(query.status ? { status: query.status } : {}) };
      const data = await ImportRowModel.find(filter).sort({ rowNumber: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).session(session).lean();
      const total = await ImportRowModel.countDocuments(filter).session(session); return { data, total };
    });
  }
  async confirm(actor: Principal, id: Types.ObjectId, input: { revision: number; assignedTo: string }, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'imports:confirm', session);
      const job = await ImportModel.findOne({ $and: [{ _id: id }, await this.scope(current, 'imports:confirm', session)] }).session(session).lean();
      if (!job) throw new AppError(404, 'NOT_FOUND', 'Import not found');
      await this.commercial.importBranch(current, 'imports:confirm', job.branchId, session); await this.commercial.importBranch(current, 'leads:import', job.branchId, session);
      await this.commercial.recipient(new Types.ObjectId(input.assignedTo), job.branchId, 'customers', session);
      await this.commercial.destination(current, 'customers:assign', job.branchId, new Types.ObjectId(input.assignedTo), session);
      if (job.status === 'FAILED' && (!job.confirmedAt || !job.assignedTo?.equals(new Types.ObjectId(input.assignedTo)))) throw new AppError(409, 'IMPORT_NOT_RESUMABLE', 'Only confirmed failed imports with the same assignee can resume');
      const confirmed = await ImportModel.findOneAndUpdate({ _id: id, revision: input.revision, status: trusted({ $in: ['PREVIEW_READY', 'FAILED'] }), expiresAt: trusted({ $gt: new Date() }) },
        { $set: { status: 'QUEUED_COMMIT', assignedTo: input.assignedTo, confirmedAt: new Date(), principal: persistedPrincipal(current), attempts: 0 }, $inc: { revision: 1 } }, { session, returnDocument: 'after' }).lean();
      if (!confirmed) throw new AppError(409, 'CONFLICT', 'Import changed, expired or is not ready');
      await audit(session, context, 'CSV_IMPORT_CONFIRMED', current.userId, 'csv_import', id, { assignedTo: input.assignedTo }); return (await this.withLabels([confirmed], session))[0];
    });
  }
  async assignees(actor: Principal, id: Types.ObjectId, query: { page: number; limit: number; search?: string }) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'imports:confirm', session);
      this.commercial.authorization.require(current, 'leads:import');
      this.commercial.authorization.require(current, 'customers:assign');
      const job = await ImportModel.findOne({ $and: [{ _id: id }, await this.scope(current, 'imports:confirm', session)] }).session(session).lean();
      if (!job) throw new AppError(404, 'NOT_FOUND', 'Import not found');
      await this.commercial.importBranch(current, 'imports:confirm', job.branchId, session);
      await this.commercial.importBranch(current, 'leads:import', job.branchId, session);
      const role = await RoleModel.findOne({ code: 'TC', isActive: true }).session(session).lean();
      const grants = role ? await this.commercial.authorization.grants(role._id, session) : null;
      if (!role || !grants?.some((grant) => grant.permission === 'customers:receive_assignment') ||
        !grants.some((grant) => grant.permission === 'customers:read' && ['ASSIGNED', 'ALL', 'BRANCH'].includes(grant.scope))) return { data: [], total: 0 };
      // Mirror destination authorization before pagination; never require broad employee-directory access.
      const destinations: Record<string, unknown>[] = [];
      for (const grant of current.grants.filter((entry) => entry.permission === 'customers:assign')) {
        if (grant.scope === 'ALL' || (grant.scope === 'BRANCH' && current.branchId?.equals(job.branchId))) { destinations.push({}); break; }
        if (['SELF', 'ASSIGNED'].includes(grant.scope) && current.branchId?.equals(job.branchId)) destinations.push({ _id: current.userId });
        if (grant.scope === 'DIRECT_REPORTS' || grant.scope === 'REPORTING_SUBTREE') {
          destinations.push({ _id: trusted({ $in: await this.commercial.scopes.descendants(current.userId, grant.scope === 'DIRECT_REPORTS', session) }) });
        }
      }
      if (!destinations.length) return { data: [], total: 0 };
      const filter: Record<string, unknown> = { $and: [{ branchId: job.branchId, roleId: role._id, isActive: true, employmentStatus: 'ACTIVE' }, { $or: destinations },
        ...(query.search ? [{ $or: ['firstName', 'lastName', 'employeeCode'].map((field) => ({ [field]: literalPrefix(query.search ?? '') })) }] : [])] };
      const data = await UserModel.find(filter).select('_id firstName lastName employeeCode').sort({ firstName: 1, lastName: 1, _id: 1 })
        .skip((query.page - 1) * query.limit).limit(query.limit).session(session).lean();
      const total = await UserModel.countDocuments(filter).session(session);
      return { data, total };
    });
  }
}
