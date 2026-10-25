import { SignJWT, jwtVerify } from 'jose';
import { Types } from 'mongoose';
import type { AppConfig } from '../../config/env.js';
import { AppError } from '../../shared/errors/app-error.js';

export class TokenService {
  private readonly key: Uint8Array;
  constructor(private readonly config: AppConfig) { this.key = new TextEncoder().encode(config.jwtSecret); }

  sign(userId: Types.ObjectId, sessionId: Types.ObjectId, authVersion: number): Promise<string> {
    return new SignJWT({ sid: sessionId.toHexString(), av: authVersion })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).setSubject(userId.toHexString())
      .setIssuer(this.config.jwtIssuer).setAudience(this.config.jwtAudience)
      .setIssuedAt().setExpirationTime(`${String(this.config.accessTtlSeconds)}s`).sign(this.key);
  }
  async verify(token: string): Promise<{ userId: Types.ObjectId; sessionId: Types.ObjectId; authVersion: number }> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'], issuer: this.config.jwtIssuer, audience: this.config.jwtAudience,
        typ: 'JWT', requiredClaims: ['sub', 'sid', 'av', 'iat', 'exp'], maxTokenAge: `${String(this.config.accessTtlSeconds)}s`,
      });
      if (typeof payload.sub !== 'string' || !/^[a-f0-9]{24}$/.test(payload.sub) ||
        typeof payload.sid !== 'string' || !/^[a-f0-9]{24}$/.test(payload.sid) ||
        typeof payload.av !== 'number' || !Number.isSafeInteger(payload.av) || payload.av < 0) throw new Error('Invalid claims');
      return { userId: new Types.ObjectId(payload.sub), sessionId: new Types.ObjectId(payload.sid), authVersion: payload.av };
    } catch { throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required'); }
  }
}
