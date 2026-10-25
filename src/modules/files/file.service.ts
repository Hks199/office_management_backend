import { randomUUID } from 'node:crypto';
import { Types, trusted, type ClientSession } from 'mongoose';
import type { AppConfig } from '../../config/env.js';
import type { Principal } from '../auth/auth.types.js';
import { FileModel, type UploadInput } from './file.model.js';
import { S3PhotoStorage, type PhotoStorage } from './s3-storage.js';
import { OrganizationAccess } from '../../shared/services/organization-access.js';
import { ScopeService } from '../permissions/authorization.service.js';
import { AttendanceModel } from '../attendance/attendance.model.js';
import { AppError } from '../../shared/errors/app-error.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
const secretFields = '+objectKey +bucket +checksumSHA256 +versionId';
export class FileService {
  private readonly access = new OrganizationAccess(); private readonly scopes = new ScopeService();
  private readonly storage: PhotoStorage;
  constructor(private readonly config: AppConfig, storage?: PhotoStorage) { this.storage = storage ?? new S3PhotoStorage(config); }
  async intent(actor: Principal, input: UploadInput, context: AuditContext) {
    const extensions: Record<string, string[]> = { 'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/webp': ['webp'] };
    const extension = input.filename.split('.').at(-1)?.toLowerCase() ?? '';
    if (!extensions[input.contentType]?.includes(extension)) throw new AppError(400, 'INVALID_PHOTO', 'Photo extension must match its type');
    if (!this.config.s3Bucket || !this.config.awsRegion) throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Private photo storage is not configured');
    const objectKey = `sunvika/attendance/${actor.userId.toHexString()}/${new Date().toISOString().slice(0, 7)}/${randomUUID()}.${extension}`;
    const photo = { bucket: this.config.s3Bucket, objectKey, contentType: input.contentType, size: input.size, checksumSHA256: input.checksumSHA256 };
    const upload = await this.storage.upload(photo);
    const file = await this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'files:upload', session);
      // Attendance uploads require attendance submission authority as well as file authority.
      if (!current.grants.some((grant) => grant.permission === 'attendance:create')) throw new AppError(403, 'FORBIDDEN', 'Access denied');
      if (await FileModel.countDocuments({ ownerId: current.userId, status: trusted({ $in: ['PENDING', 'READY'] }) }).session(session) >= 20) {
        throw new AppError(429, 'UPLOAD_LIMIT', 'Complete attendance or wait for orphan cleanup before requesting more uploads');
      }
      const expiresAt = new Date(Date.now() + 300000);
      const [created] = await FileModel.create([{ ...photo, ownerId: current.userId, purpose: input.purpose, expiresAt }], { session });
      if (!created) throw new Error('File insertion failed');
      await audit(session, context, 'FILE_UPLOAD_REQUESTED', current.userId, 'file', created._id, { purpose: input.purpose });
      return { fileId: created._id, expiresAt };
    });
    return { ...file, upload: { method: 'POST', ...upload }, instructions: 'Submit every returned field and append the file last. Confirm before marking attendance.' };
  }
  async confirm(actor: Principal, id: Types.ObjectId, context: AuditContext) {
    const file = await FileModel.findOne({ _id: id, ownerId: actor.userId, purpose: trusted({ $in: ['ATTENDANCE_CHECK_IN', 'ATTENDANCE_CHECK_OUT'] }), status: 'PENDING', expiresAt: trusted({ $gt: new Date() }) }).select(secretFields).lean();
    if (!file) throw new AppError(404, 'NOT_FOUND', 'Pending upload not found or expired');
    const versionId = await this.storage.verify(file);
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'files:upload', session);
      const confirmedAt = new Date();
      const ready = await FileModel.findOneAndUpdate({ _id: id, ownerId: current.userId, status: 'PENDING', expiresAt: trusted({ $gt: confirmedAt }) },
        { $set: { status: 'READY', versionId, confirmedAt } }, { session, returnDocument: 'after' }).lean();
      if (!ready) throw new AppError(409, 'CONFLICT', 'Upload already confirmed or expired');
      await audit(session, context, 'FILE_UPLOADED', current.userId, 'file', id, { purpose: ready.purpose });
      return ready;
    });
  }
  async attach(id: string, actor: Principal, purpose: UploadInput['purpose'], attendanceId: Types.ObjectId, session: ClientSession, now: Date) {
    const file = await FileModel.findOneAndUpdate({ _id: new Types.ObjectId(id), ownerId: actor.userId, purpose, status: 'READY',
      confirmedAt: trusted({ $gte: new Date(now.getTime() - 900000) }), expiresAt: trusted({ $gt: now }) },
    { $set: { status: 'ATTACHED', attendanceId } }, { session, returnDocument: 'after' }).lean();
    if (!file) throw new AppError(400, 'INVALID_PHOTO', 'Photo must be a fresh confirmed upload owned by you with the correct purpose');
    return file._id;
  }
  async download(actor: Principal, id: Types.ObjectId) {
    // Serialize authorization with employee/role transfers before minting a short-lived capability.
    const file = await this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'files:read', session);
      const found = await FileModel.findOne({ _id: id, status: 'ATTACHED' }).select(secretFields).session(session).lean();
      if (!found?.attendanceId || !found.versionId) throw new AppError(404, 'NOT_FOUND', 'Attached photo not found');
      if (!found.ownerId.equals(current.userId) && !current.grants.some((grant) => grant.permission === 'files:read' && grant.scope === 'ALL')) {
        throw new AppError(404, 'NOT_FOUND', 'Attached photo not found');
      }
      const scope = await this.scopes.predicate(current, 'attendance:read', { ownerField: 'employeeId', branchField: 'branchId' }, session);
      const record = await AttendanceModel.exists({ $and: [{ _id: found.attendanceId }, scope] }).session(session);
      if (!record) throw new AppError(404, 'NOT_FOUND', 'Attached photo not found');
      return found;
    });
    if (!file.versionId) throw new AppError(404, 'NOT_FOUND', 'Attached photo not found');
    return { url: await this.storage.download(file, file.versionId), expiresInSeconds: 60 };
  }
  async attendancePhoto(actor: Principal, attendanceId: Types.ObjectId, checkout: boolean) {
    const file = await this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'attendance:read', session);
      const scope = await this.scopes.predicate(current, 'attendance:read', { ownerField: 'employeeId', branchField: 'branchId' }, session);
      const record = await AttendanceModel.findOne({ $and: [{ _id: attendanceId }, scope] }).session(session).lean();
      const photoId = checkout ? record?.checkOutPhotoFileId : record?.checkInPhotoFileId;
      if (!photoId) throw new AppError(404, 'NOT_FOUND', 'Attendance photo not found');
      const found = await FileModel.findOne({ _id: photoId, attendanceId, status: 'ATTACHED' }).select(secretFields).session(session).lean();
      if (!found?.versionId) throw new AppError(404, 'NOT_FOUND', 'Attendance photo not found');
      return found;
    });
    if (!file.versionId) throw new AppError(404, 'NOT_FOUND', 'Attendance photo not found');
    return { url: await this.storage.download(file, file.versionId), expiresInSeconds: 60 };
  }
  async cleanup(): Promise<number> {
    let deleted = 0;
    for (let count = 0; count < 100; count++) {
      const file = await FileModel.findOneAndUpdate({ status: trusted({ $in: ['PENDING', 'READY', 'DELETING'] }),
        expiresAt: trusted({ $lt: new Date(Date.now() - 86400000) }), attendanceId: null }, { $set: { status: 'DELETING' } },
      { returnDocument: 'after', sort: { expiresAt: 1 } }).select(secretFields).lean();
      if (!file) break;
      await this.storage.remove(file);
      await FileModel.updateOne({ _id: file._id, status: 'DELETING', attendanceId: null }, { $set: { status: 'DELETED' } }); deleted++;
    }
    return deleted;
  }
}
