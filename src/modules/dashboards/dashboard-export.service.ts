import { createHash, randomUUID } from 'node:crypto';
import { Types, trusted } from 'mongoose';
import type { AppConfig } from '../../config/env.js';
import type { Principal } from '../auth/auth.types.js';
import { AuthorizationService } from '../permissions/authorization.service.js';
import { FileModel } from '../files/file.model.js';
import { storedFileFields, persistedPrincipal } from '../csv-imports/import.service.js';
import { S3CommercialStorage, type CommercialStorage } from '../csv-imports/commercial-storage.js';
import { OrganizationAccess } from '../../shared/services/organization-access.js';
import { AppError } from '../../shared/errors/app-error.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
import { DashboardExportModel } from './dashboard.model.js';
import { DashboardService } from './dashboard.service.js';
import { dashboardCsv } from './dashboard.csv.js';
import type { DashboardKind, DashboardQuery } from './dashboard.types.js';
export class DashboardExportService {
  private readonly access = new OrganizationAccess(); private readonly authorization = new AuthorizationService(); private readonly dashboards = new DashboardService(); readonly storage: CommercialStorage;
  constructor(private readonly config: AppConfig, storage?: CommercialStorage) { this.storage = storage ?? new S3CommercialStorage(config); }
  async create(actor: Principal, kind: DashboardKind, query: DashboardQuery, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'dashboard:export', session); this.authorization.require(current, 'dashboard:read');
      if (await DashboardExportModel.countDocuments({ createdBy: current.userId, status: trusted({ $in: ['QUEUED', 'PROCESSING'] }), expiresAt: trusted({ $gt: new Date() }) }).session(session) >= 5) throw new AppError(429, 'EXPORT_LIMIT', 'At most five outstanding dashboard exports');
      const [record] = await DashboardExportModel.create([{ createdBy: current.userId, principal: persistedPrincipal(current), kind, query, requestId: context.requestId, expiresAt: new Date(Date.now() + 86400000) }], { session });
      if (!record) throw new Error('Dashboard export insertion failed'); await audit(session, context, 'DASHBOARD_EXPORT_QUEUED', current.userId, 'dashboard_export', record._id); return { _id: record._id, status: record.status, expiresAt: record.expiresAt };
    });
  }
  async get(actor: Principal, id: Types.ObjectId) {
    this.authorization.require(actor, 'dashboard:export'); this.authorization.require(actor, 'dashboard:read');
    const job = await DashboardExportModel.findOne({ _id: id, createdBy: actor.userId, expiresAt: trusted({ $gt: new Date() }) }).lean();
    if (!job) throw new AppError(404, 'NOT_FOUND', 'Dashboard export not found'); return job;
  }
  async download(actor: Principal, id: Types.ObjectId) {
    const file = await this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'dashboard:export', session);
      const job = await DashboardExportModel.findOne({ _id: id, createdBy: current.userId, status: 'COMPLETED', expiresAt: trusted({ $gt: new Date() }) }).select('+query +fingerprint').session(session).lean();
      if (!job?.fileId || !job.asOf) throw new AppError(404, 'NOT_FOUND', 'Completed export not found or expired');
      const snapshot = await this.dashboards.compute(current, job.kind, job.query as DashboardQuery, session, job.asOf, true);
      if (dashboardCsv(snapshot).fingerprint !== job.fingerprint) throw new AppError(409, 'DASHBOARD_EXPORT_STALE', 'Dashboard visibility or source data changed; request a new export');
      const found = await FileModel.findOne({ _id: job.fileId, exportId: job._id, purpose: 'DASHBOARD_EXPORT', status: 'ATTACHED' }).select(storedFileFields).session(session).lean();
      if (!found?.versionId) throw new AppError(404, 'NOT_FOUND', 'Export file not found');
      await audit(session, { requestId: `dashboard-download-${id.toHexString()}` }, 'DASHBOARD_EXPORT_DOWNLOADED', current.userId, 'dashboard_export', id); return found;
    });
    if (!file.versionId) throw new AppError(404, 'NOT_FOUND', 'Export file not found'); return { url: await this.storage.download(file, file.versionId), expiresInSeconds: 60 };
  }
  async runOne(): Promise<boolean> {
    const now = new Date(); const leaseId = randomUUID();
    await DashboardExportModel.updateMany({ status: trusted({ $in: ['QUEUED', 'PROCESSING'] }), expiresAt: trusted({ $lte: now }) }, { $set: { status: 'FAILED', errorCode: 'EXPORT_EXPIRED' }, $unset: { leaseId: 1, leaseUntil: 1 } });
    await DashboardExportModel.updateMany({ status: 'PROCESSING', attempts: trusted({ $gte: 3 }), leaseUntil: trusted({ $lte: now }) }, { $set: { status: 'FAILED', errorCode: 'EXPORT_ATTEMPTS_EXHAUSTED' }, $unset: { leaseId: 1, leaseUntil: 1 } });
    const job = await DashboardExportModel.findOneAndUpdate({ status: trusted({ $in: ['QUEUED', 'PROCESSING'] }), expiresAt: trusted({ $gt: now }), attempts: trusted({ $lt: 3 }),
      $or: [{ leaseUntil: trusted({ $lte: now }) }, { leaseUntil: trusted({ $exists: false }) }] }, { $set: { status: 'PROCESSING', leaseId, leaseUntil: new Date(now.getTime() + 120000) }, $inc: { attempts: 1 } }, { returnDocument: 'after', sort: { createdAt: 1 } }).select('+principal +query').lean();
    if (!job) return false;
    try {
      if (!this.config.s3Bucket || !this.config.awsRegion) throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Private dashboard export storage is not configured');
      const actor: Principal = { ...job.principal, branchId: job.principal.branchId ?? null, grants: [] }; const asOf = new Date();
      const result = await this.access.transaction(async (session) => {
        const current = await this.access.actor(actor, 'dashboard:export', session);
        return dashboardCsv(await this.dashboards.compute(current, job.kind, job.query as DashboardQuery, session, asOf, true));
      });
      const stored = { bucket: this.config.s3Bucket, objectKey: `sunvika/exports/${job.createdBy.toHexString()}/${randomUUID()}.csv`, contentType: 'text/csv' as const, size: result.body.length, checksumSHA256: createHash('sha256').update(result.body).digest('base64') };
      const fileId = await this.access.transaction(async (session) => {
        const current = await this.access.actor(actor, 'dashboard:export', session);
        if (!await DashboardExportModel.exists({ _id: job._id, leaseId, leaseUntil: trusted({ $gt: new Date() }), expiresAt: trusted({ $gt: new Date() }) }).session(session)) throw new AppError(409, 'LEASE_LOST', 'Export lease expired');
        const [file] = await FileModel.create([{ ...stored, ownerId: current.userId, purpose: 'DASHBOARD_EXPORT', status: 'PENDING', expiresAt: job.expiresAt }], { session });
        if (!file) throw new Error('Dashboard file insertion failed'); return file._id;
      });
      const versionId = await this.storage.write(stored, result.body);
      await this.access.transaction(async (session) => {
        const current = await this.access.actor(actor, 'dashboard:export', session);
        const check = dashboardCsv(await this.dashboards.compute(current, job.kind, job.query as DashboardQuery, session, asOf, true));
        if (check.fingerprint !== result.fingerprint) throw new AppError(409, 'DASHBOARD_EXPORT_STALE', 'Export visibility or data changed during generation');
        if (!await DashboardExportModel.exists({ _id: job._id, leaseId, leaseUntil: trusted({ $gt: new Date() }), expiresAt: trusted({ $gt: new Date() }) }).session(session)) throw new AppError(409, 'LEASE_LOST', 'Export lease expired');
        await FileModel.updateOne({ _id: fileId, status: 'PENDING', ownerId: current.userId }, { $set: { status: 'ATTACHED', versionId, exportId: job._id, confirmedAt: new Date() } }, { session });
        await DashboardExportModel.updateOne({ _id: job._id, leaseId }, { $set: { status: 'COMPLETED', fileId, asOf, fingerprint: result.fingerprint, errorCode: '' }, $unset: { leaseId: 1, leaseUntil: 1 } }, { session });
        await audit(session, job, 'DASHBOARD_EXPORT_COMPLETED', current.userId, 'dashboard_export', job._id, { kind: job.kind });
      });
    } catch (error) {
      await DashboardExportModel.updateOne({ _id: job._id, leaseId }, { $set: { status: job.attempts < 3 && !(error instanceof AppError && error.statusCode < 500) ? 'QUEUED' : 'FAILED', errorCode: error instanceof AppError ? error.code : 'STORAGE_OR_JOB_FAILURE' }, $unset: { leaseId: 1, leaseUntil: 1 } });
    }
    return true;
  }
}
