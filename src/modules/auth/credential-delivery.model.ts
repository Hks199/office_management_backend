import { Schema, model } from 'mongoose';
export const DELIVERY_ERROR_CODES = ['SMTP_AUTHENTICATION_FAILED', 'SMTP_CONNECTION_FAILED', 'SMTP_TIMEOUT',
  'SMTP_REJECTED', 'TOKEN_DECRYPTION_FAILED', 'DELIVERY_FAILED'] as const;
export type DeliveryErrorCode = typeof DELIVERY_ERROR_CODES[number];

const schema = new Schema({
  credentialId: { type: Schema.Types.ObjectId, required: true, unique: true },
  userId: { type: Schema.Types.ObjectId, required: true },
  encryptedToken: { type: String, required: true, select: false },
  purpose: { type: String, enum: ['INVITATION', 'PASSWORD_RESET'], required: true },
  expiresAt: { type: Date, required: true },
  status: { type: String, enum: ['PENDING', 'PROCESSING', 'SENT', 'FAILED', 'EXPIRED'], default: 'PENDING', required: true },
  attempts: { type: Number, default: 0, required: true },
  lastErrorCode: { type: String, enum: DELIVERY_ERROR_CODES },
  leaseUntil: { type: Date, default: null },
  leaseId: { type: String, default: null },
}, { timestamps: true, strict: 'throw', collection: 'credential_deliveries' });
schema.index({ status: 1, leaseUntil: 1 });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const CredentialDeliveryModel = model('CredentialDelivery', schema);
