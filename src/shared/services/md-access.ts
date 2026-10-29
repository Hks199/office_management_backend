import type { ClientSession } from 'mongoose';
import type { Principal } from '../../modules/auth/auth.types.js';
import { RoleModel } from '../../modules/roles/role.model.js';
import { AppError } from '../errors/app-error.js';
export async function isManagingDirector(actor: Principal, session?: ClientSession): Promise<boolean> {
  if (actor.employeePanel) return false;
  return Boolean(await RoleModel.exists({ _id: actor.roleId, code: 'MD', isSystemRole: true, isActive: true }).session(session ?? null));
}
export async function requireManagingDirector(actor: Principal, session?: ClientSession): Promise<void> {
  if (!await isManagingDirector(actor, session)) throw new AppError(403, 'MD_ONLY', 'Only the MD can access office timings and holidays');
}
