import type { Types } from 'mongoose';
import type { Grant } from '../../constants/permissions.js';

export interface Principal {
  userId: Types.ObjectId; roleId: Types.ObjectId; sessionId: Types.ObjectId;
  branchId: Types.ObjectId | null; grants: Grant[]; authVersion: number;
}
export interface SessionCredentials {
  accessToken: string; refreshToken: string; csrfToken: string; expiresAt: Date;
}
