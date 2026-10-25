import { randomUUID } from 'node:crypto';
import { trusted } from 'mongoose';
import nodemailer from 'nodemailer';
import type { AppConfig } from '../config/env.js';
import { CredentialDeliveryModel, type DeliveryErrorCode } from '../modules/auth/credential-delivery.model.js';
import { CredentialTokenModel } from '../modules/auth/auth.models.js';
import { UserModel } from '../modules/users/user.model.js';
import { decryptSecret } from '../shared/utils/crypto.js';

export interface CredentialMessage { to: string; subject: string; text: string }
export type SendCredential = (message: CredentialMessage) => Promise<void>;

export function smtpDelivery(config: AppConfig): SendCredential {
  if (!config.smtpHost || !config.mailFrom) throw new Error('SMTP_HOST and MAIL_FROM are required for credential delivery');
  const transport = nodemailer.createTransport({ host: config.smtpHost, port: config.smtpPort,
    secure: config.smtpSecure, requireTLS: !config.smtpSecure,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    ...(config.smtpUser && config.smtpPassword ? { auth: { user: config.smtpUser, pass: config.smtpPassword } } : {}) });
  return async (message) => { await transport.sendMail({ from: config.mailFrom, ...message, disableFileAccess: true, disableUrlAccess: true }); };
}

function failureCode(error: unknown, phase: 'prepare' | 'decrypt' | 'send' | 'acknowledge'): DeliveryErrorCode {
  if (phase === 'decrypt') return 'TOKEN_DECRYPTION_FAILED';
  if (phase !== 'send') return 'DELIVERY_FAILED';
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  if (code === 'EAUTH') return 'SMTP_AUTHENTICATION_FAILED';
  if (code === 'ETIMEDOUT') return 'SMTP_TIMEOUT';
  if (code === 'ECONNECTION' || code === 'ESOCKET' || code === 'EDNS') return 'SMTP_CONNECTION_FAILED';
  if (code === 'EENVELOPE' || code === 'EMESSAGE') return 'SMTP_REJECTED';
  return 'DELIVERY_FAILED';
}

export async function deliverCredentials(config: AppConfig, send: SendCredential, limit = 50,
  signal?: AbortSignal, onFailure?: (code: DeliveryErrorCode) => void): Promise<number> {
  let sent = 0;
  for (let index = 0; index < limit; index++) {
    if (signal?.aborted) break;
    const leaseId = randomUUID();
    const now = new Date();
    const job = await CredentialDeliveryModel.findOneAndUpdate({ expiresAt: trusted({ $gt: now }),
      attempts: trusted({ $lt: 5 }), $or: [{ status: 'PENDING' }, { status: 'FAILED', leaseUntil: trusted({ $lte: now }) },
        { status: 'PROCESSING', leaseUntil: trusted({ $lte: now }) }] },
    { $set: { status: 'PROCESSING', leaseId, leaseUntil: new Date(Date.now() + 120000) }, $inc: { attempts: 1 } },
    { returnDocument: 'after', sort: { createdAt: 1 } }).select('+encryptedToken').lean();
    if (!job) break;
    const filter = { _id: job._id, leaseId };
    let phase: 'prepare' | 'decrypt' | 'send' | 'acknowledge' = 'prepare';
    try {
      const credential = await CredentialTokenModel.exists({ _id: job.credentialId, consumedAt: null, expiresAt: trusted({ $gt: new Date() }) });
      const user = await UserModel.findOne({ _id: job.userId, isActive: true, employmentStatus: trusted({ $ne: 'EXITED' }) }).lean();
      if (!credential || !user) {
        await CredentialDeliveryModel.updateOne(filter, { $set: { status: 'EXPIRED' }, $unset: { encryptedToken: 1, lastErrorCode: 1 } });
        continue;
      }
      phase = 'decrypt';
      const token = decryptSecret(job.encryptedToken, config.tokenEncryptionKey);
      const path = job.purpose === 'INVITATION' ? '/accept-invitation' : '/reset-password';
      const url = `${config.credentialUiOrigin}${path}#token=${token}`;
      phase = 'send';
      await send({ to: user.email, subject: job.purpose === 'INVITATION' ? 'Set up your Sunvika account' : 'Reset your Sunvika password',
        text: `Open this link to set your password: ${url}\nThis single-use link expires at ${job.expiresAt.toISOString()}. If you did not request this, ignore it.` });
      phase = 'acknowledge';
      await CredentialDeliveryModel.updateOne(filter, { $set: { status: 'SENT', leaseUntil: null }, $unset: { encryptedToken: 1, lastErrorCode: 1 } });
      sent++;
    } catch (error) {
      // Provider errors can include recipient and message contents; retain only retry state.
      const code = failureCode(error, phase);
      await CredentialDeliveryModel.updateOne(filter, { $set: { status: 'FAILED', lastErrorCode: code, leaseUntil: new Date(Date.now() + 60000) } });
      onFailure?.(code);
    }
  }
  return sent;
}
