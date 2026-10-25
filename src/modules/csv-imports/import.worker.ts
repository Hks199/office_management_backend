import { randomUUID } from 'node:crypto';
import { Types, trusted, type ClientSession } from 'mongoose';
import type { Principal } from '../auth/auth.types.js';
import type { ContactInput } from '../leads/commercial.types.js';
import { ImportModel, ImportRowModel } from './import.models.js';
import { FileModel } from '../files/file.model.js';
import { CustomerModel, CommercialSettingsModel, AssignmentModel } from '../leads/commercial.models.js';
import { locationModels, type LocationKind } from '../locations/location.model.js';
import { LocationService } from '../locations/location.service.js';
import { CommercialAccess } from '../leads/commercial-access.js';
import { OrganizationAccess } from '../../shared/services/organization-access.js';
import { AppError } from '../../shared/errors/app-error.js';
import { audit } from '../activity-logs/audit.service.js';
import { contactSchema, normalizePhone } from '../leads/commercial.validator.js';
import { csvRecords } from './csv.js';
import { storedFileFields } from './import.service.js';
import type { CommercialStorage } from './commercial-storage.js';

interface Job { id: Types.ObjectId; createdBy: Types.ObjectId; leaseId: string; actor: Principal; branchId: Types.ObjectId; fileId: Types.ObjectId; assignedTo: Types.ObjectId | null;
  duplicateScope: 'BRANCH' | 'COMPANY'; columnMapping: Record<string, string>; requestId: string; attempts: number; commit: boolean }
interface StagedRow { rowNumber: number; status: 'VALID' | 'REJECTED' | 'DUPLICATE'; normalizedData: ContactInput | null; rowErrors: string[];
  inputLocation?: { state: string; district: string; block: string }; rowIssues?: { field: string; code: string }[] }
export function customerDedupeKey(scope: 'BRANCH' | 'COMPANY', branch: Types.ObjectId, mobile: string): string { return `${scope === 'BRANCH' ? branch.toHexString() : 'COMPANY'}:${mobile}`; }
export class ImportWorker {
  private readonly access = new OrganizationAccess(); private readonly commercial = new CommercialAccess(); private readonly locations = new LocationService();
  constructor(private readonly storage: CommercialStorage) {}
  private readonly locationCache = new Map<string, string>();
  private async authorized(job: Job, session: ClientSession) {
    const actor = await this.access.actor(job.actor, job.commit ? 'imports:confirm' : 'imports:create', session);
    await this.commercial.importBranch(actor, job.commit ? 'imports:confirm' : 'imports:create', job.branchId, session);
    await this.commercial.importBranch(actor, 'leads:import', job.branchId, session);
    const sourceScope = await this.commercial.scopes.predicate(actor, job.commit ? 'imports:confirm' : 'imports:create',
      { ownerField: 'createdBy', hierarchyField: 'createdBy', branchField: 'branchId' }, session);
    if (!job.createdBy.equals(actor.userId) && !await ImportModel.exists({ $and: [{ _id: job.id }, sourceScope] }).session(session)) {
      throw new AppError(403, 'FORBIDDEN_SOURCE', 'Import source is no longer in your scope');
    }
    const lease = await ImportModel.updateOne({ _id: job.id, leaseId: job.leaseId, leaseUntil: trusted({ $gt: new Date() }), expiresAt: trusted({ $gt: new Date() }) },
      { $set: { leaseUntil: new Date(Date.now() + 120000) } }, { session });
    if (lease.matchedCount !== 1) throw new AppError(409, 'LEASE_LOST', 'Import worker lease or preview lifetime expired');
    const settings = await CommercialSettingsModel.findById('customers').session(session).lean();
    if (settings?.duplicateScope !== job.duplicateScope) throw new AppError(409, 'DEDUPE_POLICY_CHANGED', 'Create a new preview under the current duplicate policy');
    return actor;
  }
  private async resolve(kind: LocationKind, value: string, parentId?: string): Promise<string> {
    value = value.trim();
    const key = `${kind}:${parentId ?? ''}:${value.toUpperCase()}`; const cached = this.locationCache.get(key); if (cached) return cached;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const results = await locationModels[kind].find({ isActive: true, ...(parentId ? { [kind === 'districts' ? 'stateId' : 'districtId']: new Types.ObjectId(parentId) } : {}),
      $or: [{ code: value.toUpperCase() }, { name: trusted({ $regex: `^${escaped}$`, $options: 'i' }) }] }).limit(2).lean();
    if (results.length !== 1 || !results[0]) throw new AppError(400, 'INVALID_LOCATION', 'Location is unknown, inactive or ambiguous',
      [{ field: kind === 'states' ? 'state' : kind === 'districts' ? 'district' : 'block', code: 'NOT_FOUND_OR_AMBIGUOUS' }]);
    if (this.locationCache.size >= 1000) this.locationCache.clear(); const id = results[0]._id.toHexString(); this.locationCache.set(key, id); return id;
  }
  private async normalize(values: Record<string, string>): Promise<ContactInput> {
    const stateId = await this.resolve('states', values.state ?? ''); const districtId = await this.resolve('districts', values.district ?? '', stateId);
    const blockId = values.block?.trim() ? await this.resolve('blocks', values.block, districtId) : null;
    const result = contactSchema.validate({ customerName: values.customerName, mobileNumber: values.mobileNumber, alternateNumber: values.alternateNumber ?? '',
      stateId, districtId, blockId, siteAddress: values.siteAddress, remarks: values.remarks ?? '' }, { abortEarly: false, allowUnknown: false });
    if (result.error) throw new AppError(400, 'INVALID_CUSTOMER_ROW', 'Contact row is invalid',
      result.error.details.map((detail) => ({ field: detail.path.join('.'), code: detail.type }))); return result.value as ContactInput;
  }
  private async stage(job: Job, rows: StagedRow[]) {
    await this.access.transaction(async (session) => {
      await this.authorized(job, session);
      await ImportRowModel.insertMany(rows.map((row) => ({ ...row, importId: job.id, expiresAt: new Date(Date.now() + 2592000000) })), { session });
    });
  }
  private async validate(job: Job) {
    this.locationCache.clear();
    await this.access.transaction(async (session) => {
      await this.authorized(job, session); await ImportRowModel.deleteMany({ importId: job.id }).session(session);
    });
    const file = await FileModel.findOne({ _id: job.fileId, importId: job.id, status: 'ATTACHED', purpose: 'CUSTOMER_IMPORT' }).select(storedFileFields).lean();
    if (!file?.versionId) throw new AppError(400, 'INVALID_CSV_FILE', 'Attached CSV version is unavailable');
    const source = await this.storage.open(file, file.versionId); const seen = new Set<string>(); let header: string[] | null = null;
    const columnMapping = { ...job.columnMapping };
    let totalRows = 0; let rejectedRows = 0; let duplicateRows = 0; let acceptedRows = 0; let batch: StagedRow[] = [];
    for await (const row of csvRecords(source, file.size)) {
      if (!header) {
        // Accept the previous default header without breaking existing files or queued jobs.
        const name = columnMapping.customerName;
        if ((name === 'Contact Name' || name === 'Customer Name') && !row.includes(name)) {
          const alternate = name === 'Contact Name' ? 'Customer Name' : 'Contact Name';
          if (row.includes(alternate)) columnMapping.customerName = alternate;
        }
        if (new Set(row).size !== row.length || new Set(Object.values(columnMapping)).size !== Object.values(columnMapping).length || Object.values(columnMapping).some((name) => !row.includes(name))) throw new AppError(400, 'INVALID_CSV_HEADER', 'CSV headers must be unique and include every mapped column');
        header = row; continue;
      }
      totalRows++; const values: Record<string, string> = {};
      for (const [field, name] of Object.entries(columnMapping)) values[field] = row[header.indexOf(name)] ?? '';
      let staged: StagedRow;
      try {
        const normalized = await this.normalize(values); const key = customerDedupeKey(job.duplicateScope, job.branchId, normalizePhone(normalized.mobileNumber));
        const duplicate = seen.has(key) || Boolean(await CustomerModel.exists({ dedupeKey: key })); seen.add(key);
        staged = { rowNumber: totalRows + 1, status: duplicate ? 'DUPLICATE' : 'VALID', normalizedData: normalized, rowErrors: duplicate ? ['DUPLICATE'] : [] };
        if (duplicate) duplicateRows++; else acceptedRows++;
      } catch (error) {
        if (!(error instanceof AppError) || error.statusCode !== 400) throw error;
        staged = { rowNumber: totalRows + 1, status: 'REJECTED', normalizedData: null, rowErrors: [error.code], rowIssues: error.details }; rejectedRows++;
      }
      staged.inputLocation = { state: values.state ?? '', district: values.district ?? '', block: values.block ?? '' };
      batch.push(staged); if (batch.length >= 50) { await this.stage(job, batch); batch = []; }
    }
    if (!header || totalRows === 0) throw new AppError(400, 'EMPTY_CSV', 'CSV requires a header and at least one contact row');
    if (batch.length) await this.stage(job, batch);
    await this.access.transaction(async (session) => {
      const actor = await this.authorized(job, session);
      await ImportModel.updateOne({ _id: job.id, leaseId: job.leaseId }, { $set: { status: 'PREVIEW_READY', totalRows, rejectedRows, duplicateRows, acceptedRows, errorCode: '' },
        $unset: { leaseId: 1, leaseUntil: 1 }, $inc: { revision: 1 } }, { session });
      await audit(session, job, 'CSV_PREVIEW_READY', actor.userId, 'csv_import', job.id, { totalRows: String(totalRows), acceptedRows: String(acceptedRows), rejectedRows: String(rejectedRows), duplicateRows: String(duplicateRows) });
    });
  }
  private async commit(job: Job) {
    if (!job.assignedTo) throw new AppError(400, 'INVALID_ASSIGNEE', 'A contact assignee is required');
    const assignedTo = job.assignedTo;
    for (;;) {
      const done = await this.access.transaction(async (session) => {
        const actor = await this.authorized(job, session); await this.commercial.recipient(assignedTo, job.branchId, 'customers', session);
        await this.commercial.destination(actor, 'customers:assign', job.branchId, assignedTo, session);
        const rows = await ImportRowModel.find({ importId: job.id, status: 'VALID' }).sort({ rowNumber: 1 }).limit(50).session(session).lean();
        if (!rows.length) {
          await ImportModel.updateOne({ _id: job.id, leaseId: job.leaseId }, { $set: { status: 'COMPLETED', finishedAt: new Date(), errorCode: '' }, $unset: { leaseId: 1, leaseUntil: 1 }, $inc: { revision: 1 } }, { session });
          await audit(session, job, 'CSV_IMPORT_COMPLETED', actor.userId, 'csv_import', job.id); return true;
        }
        let importedRows = 0; let duplicates = 0;
        for (const row of rows) {
          const result = contactSchema.validate(row.normalizedData, { allowUnknown: false, abortEarly: false });
          if (result.error) throw new AppError(409, 'STAGING_UNAVAILABLE', 'Validated staging data is invalid or expired');
          const input = result.value as ContactInput; await this.locations.assertChain(input, session);
          const dedupeKey = customerDedupeKey(job.duplicateScope, job.branchId, input.mobileNumber);
          if (await CustomerModel.exists({ dedupeKey }).session(session)) {
            await ImportRowModel.updateOne({ _id: row._id }, { $set: { status: 'DUPLICATE', rowErrors: ['DUPLICATE_AT_COMMIT'] } }, { session }); duplicates++; continue;
          }
          const [customer] = await CustomerModel.create([{ ...input, branchId: job.branchId, dedupeKey, importId: job.id, importRow: row.rowNumber,
            createdBy: actor.userId, assignedTo, assignedBy: actor.userId, assignedAt: new Date() }], { session });
          if (!customer) throw new Error('Contact insertion failed');
          await AssignmentModel.create([{ entityType: 'CUSTOMER', entityId: customer._id, assignedTo, assignedBy: actor.userId,
            reason: 'Confirmed CSV import', entityRevision: 0 }], { session });
          await ImportRowModel.updateOne({ _id: row._id }, { $set: { status: 'IMPORTED' } }, { session }); importedRows++;
        }
        await ImportModel.updateOne({ _id: job.id, leaseId: job.leaseId }, { $inc: { importedRows, duplicateRows: duplicates, acceptedRows: -duplicates, revision: 1 } }, { session });
        await audit(session, job, 'CUSTOMERS_IMPORTED', actor.userId, 'csv_import', job.id, { importedRows: String(importedRows), concurrentDuplicates: String(duplicates) }); return false;
      });
      if (done) return;
    }
  }
  async runOne(): Promise<boolean> {
    const leaseId = randomUUID(); const now = new Date();
    const record = await ImportModel.findOneAndUpdate({ status: trusted({ $in: ['QUEUED_VALIDATION', 'VALIDATING', 'QUEUED_COMMIT', 'PROCESSING'] }),
      $or: [{ leaseUntil: trusted({ $lte: now }) }, { leaseUntil: trusted({ $exists: false }) }] },
    { $set: { leaseId, leaseUntil: new Date(Date.now() + 120000) }, $inc: { attempts: 1 } }, { returnDocument: 'after', sort: { createdAt: 1 } }).select('+principal +leaseId').lean();
    if (!record) return false;
    const job: Job = { id: record._id, createdBy: record.createdBy, leaseId, actor: { ...record.principal, branchId: record.principal.branchId ?? null, grants: [] }, branchId: record.branchId,
      fileId: record.fileId, assignedTo: record.assignedTo ?? null, duplicateScope: record.duplicateScope, columnMapping: record.columnMapping,
      requestId: record.requestId, attempts: record.attempts, commit: ['QUEUED_COMMIT', 'PROCESSING'].includes(record.status) };
    try {
      await ImportModel.updateOne({ _id: job.id, leaseId }, { $set: { status: job.commit ? 'PROCESSING' : 'VALIDATING' } });
      if (job.commit) await this.commit(job); else await this.validate(job);
    } catch (error) {
      const permanent = error instanceof AppError && error.statusCode < 500;
      await ImportModel.updateOne({ _id: job.id, leaseId }, { $set: { status: permanent || job.attempts >= 3 ? 'FAILED' : job.commit ? 'QUEUED_COMMIT' : 'QUEUED_VALIDATION',
        errorCode: error instanceof AppError ? error.code : 'STORAGE_OR_JOB_FAILURE' }, $unset: { leaseId: 1, leaseUntil: 1 }, $inc: { revision: 1 } });
    }
    return true;
  }
}
