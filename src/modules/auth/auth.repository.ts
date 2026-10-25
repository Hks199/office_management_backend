import mongoose, { Types, trusted, type ClientSession } from 'mongoose';
import { UserModel } from '../users/user.model.js';
import { RefreshSessionModel, CredentialTokenModel, LoginAttemptModel } from './auth.models.js';
import { CredentialDeliveryModel } from './credential-delivery.model.js';

export class AuthRepository {
  transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    return mongoose.connection.transaction(work);
  }
  userByEmail(email: string) {
    return UserModel.findOne({ email }).select('+passwordHash').lean();
  }
  userByEmployeeCode(employeeCode: string) {
    return UserModel.findOne({ employeeCode }).select('+passwordHash').lean();
  }
  userById(id: Types.ObjectId, session?: ClientSession) {
    return UserModel.findById(id).select('+passwordHash').session(session ?? null).lean();
  }
  lockUser(id: Types.ObjectId, session: ClientSession) {
    return UserModel.findOneAndUpdate({ _id: id, isActive: true, employmentStatus: trusted({ $ne: 'EXITED' }) },
      { $inc: { authFence: 1 } }, { returnDocument: 'after', session }).select('+passwordHash').lean();
  }
  async reserveLogin(key: string, expiresAt: Date): Promise<number> {
    const now = new Date();
    const attempt = await LoginAttemptModel.findOneAndUpdate({ _id: key },
      [{ $set: {
        count: { $cond: [{ $gt: ['$expiresAt', now] }, { $add: ['$count', 1] }, 1] },
        expiresAt: { $cond: [{ $gt: ['$expiresAt', now] }, '$expiresAt', expiresAt] },
      } }], { upsert: true, returnDocument: 'after', updatePipeline: true }).lean();
    return attempt.count;
  }
  sessionByHash(hash: string, session?: ClientSession) {
    return RefreshSessionModel.findOne({ tokenHash: hash }).select('+csrfHash').session(session ?? null).lean();
  }
  activeSession(id: Types.ObjectId, userId: Types.ObjectId, session?: ClientSession) {
    return RefreshSessionModel.findOne({ _id: id, userId, revokedAt: null,
      expiresAt: trusted({ $gt: new Date() }), absoluteExpiresAt: trusted({ $gt: new Date() }) }).session(session ?? null).lean();
  }
  async createSession(data: {
    _id: Types.ObjectId; userId: Types.ObjectId; familyId: string; tokenHash: string;
    parentId: Types.ObjectId | null; expiresAt: Date; absoluteExpiresAt: Date; csrfHash: string; authVersion: number;
  }, session: ClientSession): Promise<void> {
    await RefreshSessionModel.create([data], { session });
  }
  async consumeSession(id: Types.ObjectId, replacement: Types.ObjectId, session: ClientSession): Promise<boolean> {
    const result = await RefreshSessionModel.updateOne({ _id: id, consumedAt: null, revokedAt: null },
      { $set: { consumedAt: new Date(), replacedBy: replacement } }, { session });
    return result.modifiedCount === 1;
  }
  async revokeFamily(familyId: string, session: ClientSession): Promise<void> {
    await RefreshSessionModel.updateMany({ familyId, revokedAt: null }, { $set: { revokedAt: new Date() } }, { session });
  }
  async revokeAll(userId: Types.ObjectId, session: ClientSession): Promise<void> {
    await RefreshSessionModel.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } }, { session });
  }
  async invalidateCredentials(userId: Types.ObjectId, session: ClientSession): Promise<void> {
    await CredentialTokenModel.updateMany({ userId, consumedAt: null }, { $set: { consumedAt: new Date() } }, { session });
    await CredentialDeliveryModel.updateMany({ userId, status: trusted({ $in: ['PENDING', 'PROCESSING', 'FAILED'] }) },
      { $set: { status: 'EXPIRED' }, $unset: { encryptedToken: 1, leaseId: 1 } }, { session });
  }
  async loggedIn(userId: Types.ObjectId, session: ClientSession): Promise<void> {
    await UserModel.updateOne({ _id: userId }, { $set: { lastLoginAt: new Date() } }, { session });
  }
  async changePassword(userId: Types.ObjectId, passwordHash: string, session: ClientSession): Promise<void> {
    await UserModel.updateOne({ _id: userId }, { $set: { passwordHash, passwordChangedAt: new Date() },
      $inc: { authVersion: 1 } }, { session });
    await CredentialTokenModel.updateMany({ userId, consumedAt: null }, { $set: { consumedAt: new Date() } }, { session });
    await this.revokeAll(userId, session);
  }
  credentialByHash(hash: string, purpose: 'INVITATION' | 'PASSWORD_RESET', session: ClientSession) {
    return CredentialTokenModel.findOne({ tokenHash: hash, purpose, consumedAt: null,
      expiresAt: trusted({ $gt: new Date() }) }).session(session).lean();
  }
  async consumeCredential(id: Types.ObjectId, session: ClientSession): Promise<boolean> {
    const result = await CredentialTokenModel.updateOne({ _id: id, consumedAt: null,
      expiresAt: trusted({ $gt: new Date() }) }, { $set: { consumedAt: new Date() } }, { session });
    return result.modifiedCount === 1;
  }
  async queueCredential(userId: Types.ObjectId, purpose: 'INVITATION' | 'PASSWORD_RESET',
    hash: string, encryptedToken: string, expiresAt: Date, session: ClientSession): Promise<void> {
    // Superseded reset/invitation tokens cannot remain redeemable.
    await CredentialTokenModel.updateMany({ userId, purpose, consumedAt: null }, { $set: { consumedAt: new Date() } }, { session });
    const credentialId = new Types.ObjectId();
    await CredentialTokenModel.create([{ _id: credentialId, userId, purpose, tokenHash: hash, expiresAt }], { session });
    await CredentialDeliveryModel.create([{ credentialId, userId, purpose, encryptedToken, expiresAt }], { session });
  }
}
