import { randomUUID } from 'node:crypto';
import { Types, trusted } from 'mongoose';
import type { AppConfig } from '../../config/env.js';
import type { Principal } from '../auth/auth.types.js';
import type { UploadInput } from '../files/file.model.js';
import { FileModel } from '../files/file.model.js';
import { S3PhotoStorage, type PhotoStorage } from '../files/s3-storage.js';
import { AuthorizationService } from '../permissions/authorization.service.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
import { AppError } from '../../shared/errors/app-error.js';
import { ReportService } from './report.service.js';
const secrets = '+objectKey +bucket +checksumSHA256 +versionId';
export class ReportPhotosService {
  private readonly reports = new ReportService(); private readonly authorization = new AuthorizationService(); private readonly storage: PhotoStorage;
  constructor(private readonly config: AppConfig, storage?: PhotoStorage) { this.storage = storage ?? new S3PhotoStorage(config); }
  async upload(actor: Principal, visitId: Types.ObjectId, input: Omit<UploadInput, 'purpose'>, context: AuditContext) {
    if (!this.config.s3Bucket || !this.config.awsRegion) throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Private photo storage is not configured');
    const extensions: Record<string, string[]> = { 'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/webp': ['webp'] };
    const extension = input.filename.split('.').at(-1)?.toLowerCase() ?? '';
    if (!extensions[input.contentType]?.includes(extension)) throw new AppError(400, 'INVALID_PHOTO', 'Photo extension must match its type');
    // Check the parent before any provider operation, then revalidate after signing.
    await this.reports.access.transaction(async (session) => {
      const current = await this.reports.access.actor(actor, 'reports:create', session); this.authorization.require(current, 'files:upload');
      await this.reports.ownedVisit(current, visitId, session);
    });
    const photo = { bucket: this.config.s3Bucket, objectKey: `sunvika/site-visits/${actor.userId.toHexString()}/${visitId.toHexString()}/${randomUUID()}.${extension}`, contentType: input.contentType, size: input.size, checksumSHA256: input.checksumSHA256 };
    const upload = await this.storage.upload(photo);
    const file = await this.reports.access.transaction(async (session) => {
      const current = await this.reports.access.actor(actor, 'reports:create', session); this.authorization.require(current, 'files:upload');
      await this.reports.ownedVisit(current, visitId, session);
      if (await FileModel.countDocuments({ ownerId: current.userId, status: trusted({ $in: ['PENDING', 'READY'] }) }).session(session) >= 20) throw new AppError(429, 'UPLOAD_LIMIT', 'Complete uploads or wait for cleanup');
      const expiresAt = new Date(Date.now() + 300000);
      const [created] = await FileModel.create([{ ...photo, ownerId: current.userId, visitId, purpose: 'SITE_VISIT', expiresAt }], { session });
      if (!created) throw new Error('Photo insertion failed');
      await audit(session, context, 'FILE_UPLOAD_REQUESTED', current.userId, 'file', created._id, { purpose: 'SITE_VISIT', visitId: visitId.toHexString() });
      return { fileId: created._id, expiresAt };
    });
    return { ...file, upload: { method: 'POST', ...upload } };
  }
  async confirm(actor: Principal, visitId: Types.ObjectId, fileId: Types.ObjectId, context: AuditContext) {
    const file = await this.reports.access.transaction(async (session) => {
      const current = await this.reports.access.actor(actor, 'reports:create', session); this.authorization.require(current, 'files:upload');
      await this.reports.ownedVisit(current, visitId, session);
      const found = await FileModel.findOne({ _id: fileId, visitId, ownerId: current.userId, purpose: 'SITE_VISIT', status: 'PENDING', expiresAt: trusted({ $gt: new Date() }) }).select(secrets).session(session).lean();
      if (!found) throw new AppError(404, 'NOT_FOUND', 'Pending visit photo not found or expired'); return found;
    });
    const versionId = await this.storage.verify(file);
    return this.reports.access.transaction(async (session) => {
      const current = await this.reports.access.actor(actor, 'reports:create', session); this.authorization.require(current, 'files:upload');
      await this.reports.ownedVisit(current, visitId, session);
      const ready = await FileModel.findOneAndUpdate({ _id: fileId, visitId, ownerId: current.userId, purpose: 'SITE_VISIT', status: 'PENDING', expiresAt: trusted({ $gt: new Date() }) }, { $set: { status: 'READY', confirmedAt: new Date(), versionId } }, { session, returnDocument: 'after' }).lean();
      if (!ready) throw new AppError(409, 'CONFLICT', 'Photo already confirmed or expired');
      await audit(session, context, 'FILE_UPLOADED', current.userId, 'file', fileId, { purpose: 'SITE_VISIT' }); return ready;
    });
  }
  async download(actor: Principal, visitId: Types.ObjectId, fileId: Types.ObjectId) {
    const file = await this.reports.access.transaction(async (session) => {
      const current = await this.reports.access.actor(actor, 'reports:read', session);
      const visit = await this.reports.get(current, 'VISIT', visitId, session);
      if (!visit.photoFileIds.some((id) => id.equals(fileId))) throw new AppError(404, 'NOT_FOUND', 'Visit photo not found');
      const found = await FileModel.findOne({ _id: fileId, visitId, purpose: 'SITE_VISIT', status: 'ATTACHED' }).select(secrets).session(session).lean();
      if (!found?.versionId) throw new AppError(404, 'NOT_FOUND', 'Visit photo not found'); return found;
    });
    if (!file.versionId) throw new AppError(404, 'NOT_FOUND', 'Visit photo not found');
    return { url: await this.storage.download(file, file.versionId), expiresInSeconds: 60 };
  }
}
