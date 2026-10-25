import type { ClientSession, Types } from 'mongoose';
import { ActivityLogModel } from './activity-log.model.js';

export interface AuditContext { requestId: string }
export async function audit(session: ClientSession, context: AuditContext, action: string,
  actorId: Types.ObjectId | null, entityType: string, entityId: Types.ObjectId | null,
  metadata: Record<string, string> = {}): Promise<void> {
  await ActivityLogModel.create([{ actorId, action, entityType, entityId, requestId: context.requestId, metadata }], { session });
}
