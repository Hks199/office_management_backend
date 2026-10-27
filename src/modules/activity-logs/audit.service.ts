import type { ClientSession, Types } from 'mongoose';
import { ActivityLogModel } from './activity-log.model.js';
import { employeePanelContext } from '../auth/employee-panel-context.js';

export interface AuditContext { requestId: string }
export async function audit(session: ClientSession, context: AuditContext, action: string,
  actorId: Types.ObjectId | null, entityType: string, entityId: Types.ObjectId | null,
  metadata: Record<string, string> = {}): Promise<void> {
  const panel = employeePanelContext.getStore();
  const delegated = panel && actorId?.equals(panel.employeeId);
  await ActivityLogModel.create([{ actorId: delegated ? panel.managerId : actorId, action, entityType, entityId, requestId: context.requestId,
    metadata: delegated ? { ...metadata, actingAsEmployeeId: panel.employeeId.toHexString(), employeePanelId: panel.panelId.toHexString() } : metadata }], { session });
}
