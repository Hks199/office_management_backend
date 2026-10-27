import { AsyncLocalStorage } from 'node:async_hooks';
import type { Types } from 'mongoose';

export const employeePanelContext = new AsyncLocalStorage<{
  managerId: Types.ObjectId; employeeId: Types.ObjectId; panelId: Types.ObjectId;
}>();

export function blockedPanelPermission(permission: string): boolean {
  return permission === 'users:open_panel' || permission === 'attendance:create' ||
    /^(roles:|permissions:|policies:|settings:)/.test(permission);
}
