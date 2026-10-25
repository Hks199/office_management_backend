import { Schema, model } from 'mongoose';

const sessionSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  familyId: { type: String, required: true }, tokenHash: { type: String, required: true, select: false, unique: true },
  parentId: { type: Schema.Types.ObjectId, default: null }, replacedBy: { type: Schema.Types.ObjectId, default: null },
  expiresAt: { type: Date, required: true }, absoluteExpiresAt: { type: Date, required: true },
  consumedAt: { type: Date, default: null }, revokedAt: { type: Date, default: null },
  csrfHash: { type: String, required: true, select: false },
  authVersion: { type: Number, required: true },
}, { timestamps: true, strict: 'throw', collection: 'refresh_sessions' });
sessionSchema.index({ userId: 1, revokedAt: 1 });
sessionSchema.index({ familyId: 1, revokedAt: 1 });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const RefreshSessionModel = model('RefreshSession', sessionSchema);

const tokenSchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  purpose: { type: String, enum: ['INVITATION', 'PASSWORD_RESET'], required: true },
  tokenHash: { type: String, required: true, select: false, unique: true },
  expiresAt: { type: Date, required: true }, consumedAt: { type: Date, default: null },
}, { timestamps: true, strict: 'throw', collection: 'credential_tokens' });
tokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
tokenSchema.index({ userId: 1, purpose: 1 });
export const CredentialTokenModel = model('CredentialToken', tokenSchema);

// A database-backed account throttle works across API instances. Expiration is also checked in queries.
const attemptSchema = new Schema({
  _id: { type: String, required: true }, count: { type: Number, required: true }, expiresAt: { type: Date, required: true },
}, { strict: 'throw', collection: 'login_attempts' });
attemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const LoginAttemptModel = model('LoginAttempt', attemptSchema);

const stateSchema = new Schema({
  _id: { type: String, required: true }, revision: { type: Number, default: 0, required: true },
}, { strict: 'throw', collection: 'security_state' });
export const SecurityStateModel = model('SecurityState', stateSchema);
