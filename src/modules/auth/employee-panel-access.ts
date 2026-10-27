import { Types, trusted, type ClientSession } from 'mongoose';
import { UserModel } from '../users/user.model.js';
import { AuthorizationService } from '../permissions/authorization.service.js';
import { HierarchyRepository } from '../hierarchy/hierarchy.repository.js';
import { permissionDefinition, type Grant } from '../../constants/permissions.js';
import { RefreshSessionModel } from './auth.models.js';
import { EmployeePanelModel } from './employee-panel.model.js';

export async function employeePanelAccess(managerId: Types.ObjectId, employeeId: Types.ObjectId, session?: ClientSession) {
  if (managerId.equals(employeeId)) return null;
  const manager = await UserModel.findOne({ _id: managerId, isActive: true, employmentStatus: trusted({ $ne: 'EXITED' }) }).session(session ?? null).lean();
  const employee = await UserModel.findOne({ _id: employeeId, isActive: true, employmentStatus: trusted({ $ne: 'EXITED' }) }).select('+bootstrapKey').session(session ?? null).lean();
  if (!manager || !employee || employee.bootstrapKey) return null;
  const authorization = new AuthorizationService();
  const managerGrants = await authorization.grants(manager.roleId, session);
  const grants = await authorization.grants(employee.roleId, session);
  if (!managerGrants || !grants || grants.some((grant) => permissionDefinition(grant.permission).sensitive ||
    (grant.scope === 'ALL' && grant.permission !== 'locations:read' && !managerGrants.some((held) => held.permission === grant.permission && held.scope === 'ALL')))) return null;
  const held = managerGrants.filter((grant) => grant.permission === 'users:open_panel');
  if (!held.length) return null;
  const hierarchy = new HierarchyRepository();
  const descendants = await hierarchy.descendants(managerId, session);
  if (descendants.some((node) => node.depth >= 20 || node._id.equals(managerId)) || !descendants.some((node) => node._id.equals(employeeId))) return null;
  if (!held.some((grant) => grant.scope === 'ALL' || grant.scope === 'REPORTING_SUBTREE') &&
    !(held.some((grant) => grant.scope === 'DIRECT_REPORTS') && (await hierarchy.directReports(managerId, session)).some((id) => id.equals(employeeId)))) return null;
  return { manager, employee, grants };
}

/** Also called inside every transactional actor check, so a removed manager cannot keep writing. */
export async function validEmployeePanelSession(panelId: Types.ObjectId, employeeId: Types.ObjectId,
  employeeSessionId: Types.ObjectId, session?: ClientSession): Promise<boolean> {
  const panel = await EmployeePanelModel.findOne({ _id: panelId, employeeId, employeeSessionId,
    revokedAt: null, expiresAt: trusted({ $gt: new Date() }) }).session(session ?? null).lean();
  if (!panel) return false;
  const access = await employeePanelAccess(panel.managerId, employeeId, session);
  if (!access || access.manager.authVersion !== panel.managerAuthVersion || access.employee.authVersion !== panel.employeeAuthVersion) return false;
  const source = await RefreshSessionModel.exists({ userId: panel.managerId, familyId: panel.managerFamilyId,
    authVersion: panel.managerAuthVersion, consumedAt: null, revokedAt: null,
    expiresAt: trusted({ $gt: new Date() }), absoluteExpiresAt: trusted({ $gt: new Date() }), employeePanelId: null,
  }).session(session ?? null);
  return Boolean(source);
}

export function panelGrants(grants: Grant[]) {
  return grants.filter((grant) => !['attendance:create', 'users:open_panel'].includes(grant.permission));
}
