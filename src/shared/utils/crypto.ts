import { createHash, randomBytes, createHmac, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import argon2 from 'argon2';
import { AppError } from '../errors/app-error.js';

let activePasswordJobs = 0;
const passwordWaiters: (() => void)[] = [];
async function passwordWork<T>(work: () => Promise<T>): Promise<T> {
  // Argon2 memory is bounded across all app instances in this process.
  if (activePasswordJobs >= 2) {
    if (passwordWaiters.length >= 16) throw new AppError(429, 'AUTH_BUSY', 'Authentication is busy; try again later');
    await new Promise<void>((resolve) => { passwordWaiters.push(resolve); });
  } else activePasswordJobs++;
  try { return await work(); }
  finally {
    const next = passwordWaiters.shift();
    if (next) next(); else activePasswordJobs--;
  }
}

export const randomToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const csrfToken = (family: string, secret: string) => createHmac('sha256', secret).update(`csrf:${family}`).digest('base64url');
export function constantEqual(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export const hashPassword = (password: string) => passwordWork(() => argon2.hash(password, {
  type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1,
}));
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return passwordWork(async () => {
    try { return await argon2.verify(hash, password); } catch { return false; }
  });
}

export function encryptSecret(value: string, hexKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), iv);
  cipher.setAAD(Buffer.from('sunvika:credential-delivery:v1'));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}
export function decryptSecret(value: string, hexKey: string): string {
  const parts = value.split('.');
  if (parts.length !== 3) throw new Error('Invalid encrypted credential');
  const [iv, tag, payload] = parts;
  if (!iv || !tag || !payload) throw new Error('Invalid encrypted credential');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from('sunvika:credential-delivery:v1'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(payload, 'base64url')), decipher.final()]).toString('utf8');
}
