import { createHash, randomUUID } from 'node:crypto';
import { Types, trusted } from 'mongoose';
import type { AppConfig } from '../../config/env.js';
import type { Principal } from '../auth/auth.types.js';
import type { CommercialQuery } from '../leads/commercial.types.js';
import { LeadModel } from '../leads/commercial.models.js';
import { commercialFilter } from '../leads/commercial.repository.js';
import { CommercialAccess, leadAdapter } from '../leads/commercial-access.js';
import { FileModel } from '../files/file.model.js';
import { LeadExportModel } from './import.models.js';
import { storedFileFields, persistedPrincipal } from './import.service.js';
import { csvCell } from './csv.js';
import { S3CommercialStorage, type CommercialStorage } from './commercial-storage.js';
import { OrganizationAccess } from '../../shared/services/organization-access.js';
import { AppError } from '../../shared/errors/app-error.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
export class ExportService {
  private readonly access = new OrganizationAccess(); private readonly commercial = new CommercialAccess(); readonly storage: CommercialStorage;
  constructor(private readonly config: AppConfig, storage?: CommercialStorage) { this.storage = storage ?? new S3CommercialStorage(config); }
  async create(actor: Principal, query: CommercialQuery, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'leads:export', session); this.commercial.authorization.require(current, 'leads:read');
      if (await LeadExportModel.countDocuments({ createdBy: current.userId, status: trusted({ $in: ['QUEUED', 'PROCESSING'] }) }).session(session) >= 5) throw new AppError(429, 'EXPORT_LIMIT', 'Outstanding export limit reached');
      const [record] = await LeadExportModel.create([{ createdBy: current.userId, principal: persistedPrincipal(current), query, requestId: context.requestId,
        expiresAt: new Date(Date.now() + 86400000) }], { session });
      if (!record) throw new Error('Export insertion failed');
      await audit(session, context, 'LEAD_EXPORT_QUEUED', current.userId, 'lead_export', record._id);
      return { _id: record._id, status: record.status, expiresAt: record.expiresAt };
    });
  }
  async get(actor: Principal, id: Types.ObjectId) {
    this.commercial.authorization.require(actor, 'leads:export');
    const record = await LeadExportModel.findOne({ _id: id, createdBy: actor.userId }).lean();
    if (!record) throw new AppError(404, 'NOT_FOUND', 'Export not found'); return record;
  }
  async download(actor: Principal, id: Types.ObjectId) {
    const file = await this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'leads:export', session);
      const record = await LeadExportModel.findOne({ _id: id, createdBy: current.userId, status: 'COMPLETED', expiresAt: trusted({ $gt: new Date() }) }).select('+leadIds').session(session).lean();
      if (!record?.fileId) throw new AppError(404, 'NOT_FOUND', 'Completed export not found or expired');
      const scope = { $and: [await this.commercial.scopes.predicate(current, 'leads:read', leadAdapter, session), await this.commercial.scopes.predicate(current, 'leads:export', leadAdapter, session)] };
      const visible = await LeadModel.countDocuments({ $and: [{ _id: trusted({ $in: record.leadIds }) }, scope] }).session(session);
      if (visible !== record.leadIds.length) throw new AppError(403, 'EXPORT_SCOPE_CHANGED', 'Some exported records are no longer accessible; request a new export');
      const found = await FileModel.findOne({ _id: record.fileId, exportId: id, status: 'ATTACHED' }).select(storedFileFields).session(session).lean();
      if (!found?.versionId) throw new AppError(404, 'NOT_FOUND', 'Export file not found');
      await audit(session, { requestId: `export-download-${id.toHexString()}` }, 'LEAD_EXPORT_DOWNLOADED', current.userId, 'lead_export', id); return found;
    });
    if (!file.versionId) throw new AppError(404, 'NOT_FOUND', 'Export file not found');
    return { url: await this.storage.download(file, file.versionId), expiresInSeconds: 60 };
  }
  async runOne(): Promise<boolean> {
    const leaseId = randomUUID(); const now = new Date();
    const job = await LeadExportModel.findOneAndUpdate({ status: trusted({ $in: ['QUEUED', 'PROCESSING'] }),
      $or: [{ leaseUntil: trusted({ $lte: now }) }, { leaseUntil: trusted({ $exists: false }) }] },
    { $set: { status: 'PROCESSING', leaseId, leaseUntil: new Date(Date.now() + 120000) }, $inc: { attempts: 1 } },
    { returnDocument: 'after', sort: { createdAt: 1 } }).select('+principal +query').lean();
    if (!job) return false;
    try {
      if (!this.config.s3Bucket || !this.config.awsRegion) throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Private export storage is not configured');
      const actor: Principal = { ...job.principal, branchId: job.principal.branchId ?? null, grants: [] };
      const result = await this.access.transaction(async (session) => {
        const current = await this.access.actor(actor, 'leads:export', session);
        const scope = { $and: [await this.commercial.scopes.predicate(current, 'leads:read', leadAdapter, session), await this.commercial.scopes.predicate(current, 'leads:export', leadAdapter, session)] };
        // Explicit 5,000-row/10-MiB export boundary; reject overflow rather than silently truncate.
        const rows = await LeadModel.find(commercialFilter(scope, job.query as CommercialQuery)).sort({ createdAt: 1, _id: 1 }).limit(5001).session(session).lean();
        if (rows.length > 5000) throw new AppError(400, 'EXPORT_TOO_LARGE', 'Narrow filters to at most 5000 leads');
        const header = ['Lead Code', 'Contact Name', 'Mobile Number', 'Site Address', 'Status', 'Capacity kW', 'Rate per kW', 'Estimated Value INR', 'Remarks'];
        const lines = [header.map(csvCell).join(',')];
        let bytes = Buffer.byteLength(lines[0] ?? '') + 2;
        for (const row of rows) {
          const line = [row.leadCode, row.customerName, row.mobileNumber, row.siteAddress, row.status, row.requiredCapacityKw.toString(), row.ratePerKw.toString(), row.estimatedProjectValue.toString(), row.remarks].map(csvCell).join(',');
          bytes += Buffer.byteLength(line) + 2; if (bytes > 10485760) throw new AppError(400, 'EXPORT_TOO_LARGE', 'Narrow filters to an export smaller than 10 MiB'); lines.push(line);
        }
        return { body: Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8'), ids: rows.map((row) => row._id) };
      });
      const photo = { bucket: this.config.s3Bucket, objectKey: `sunvika/exports/${job.createdBy.toHexString()}/${randomUUID()}.csv`, contentType: 'text/csv' as const,
        size: result.body.length, checksumSHA256: createHash('sha256').update(result.body).digest('base64') };
      // Persist cleanup metadata before touching S3, so failed/retried exports never leave untracked objects.
      const pending = await this.access.transaction(async (session) => {
        const current = await this.access.actor(actor, 'leads:export', session);
        if (!await LeadExportModel.exists({ _id: job._id, leaseId, leaseUntil: trusted({ $gt: new Date() }) }).session(session)) throw new AppError(409, 'LEASE_LOST', 'Export lease expired');
        const [file] = await FileModel.create([{ ...photo, ownerId: current.userId, purpose: 'LEAD_EXPORT', status: 'PENDING', expiresAt: job.expiresAt }], { session });
        if (!file) throw new Error('Export staging insertion failed'); return file._id;
      });
      const versionId = await this.storage.write(photo, result.body);
      await this.access.transaction(async (session) => {
        const current = await this.access.actor(actor, 'leads:export', session);
        const scope = { $and: [await this.commercial.scopes.predicate(current, 'leads:read', leadAdapter, session), await this.commercial.scopes.predicate(current, 'leads:export', leadAdapter, session)] };
        if (await LeadModel.countDocuments({ $and: [{ _id: trusted({ $in: result.ids }) }, scope] }).session(session) !== result.ids.length) throw new AppError(403, 'EXPORT_SCOPE_CHANGED', 'Export access changed');
        const owned = await LeadExportModel.exists({ _id: job._id, leaseId, leaseUntil: trusted({ $gt: new Date() }), expiresAt: trusted({ $gt: new Date() }) }).session(session);
        if (!owned) throw new AppError(409, 'LEASE_LOST', 'Export lease or lifetime expired');
        const file = await FileModel.findOneAndUpdate({ _id: pending, status: 'PENDING' }, { $set: { versionId, status: 'ATTACHED', exportId: job._id, confirmedAt: new Date() } }, { session, returnDocument: 'after' }).lean();
        if (!file) throw new Error('Export file insertion failed');
        await LeadExportModel.updateOne({ _id: job._id, leaseId }, { $set: { status: 'COMPLETED', fileId: file._id, leadIds: result.ids, errorCode: '' }, $unset: { leaseId: 1, leaseUntil: 1 } }, { session });
        await audit(session, job, 'LEAD_EXPORT_COMPLETED', current.userId, 'lead_export', job._id, { rows: String(result.ids.length) });
      });
    } catch (error) {
      await LeadExportModel.updateOne({ _id: job._id, leaseId }, { $set: { status: job.attempts < 3 && !(error instanceof AppError && error.statusCode < 500) ? 'QUEUED' : 'FAILED',
        errorCode: error instanceof AppError ? error.code : 'STORAGE_OR_JOB_FAILURE' }, $unset: { leaseId: 1, leaseUntil: 1 } });
    }
    return true;
  }
}
