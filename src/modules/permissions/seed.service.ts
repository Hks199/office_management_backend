import { Types, type ClientSession } from 'mongoose';
import { PERMISSION_CODES, permissionDefinition, type Grant, type PermissionCode, type DataScope } from '../../constants/permissions.js';
import { PermissionModel } from './permission.model.js';
import { RoleModel } from '../roles/role.model.js';
import { RolePolicyModel } from '../roles/role-policy.model.js';

export const SYSTEM_ROLES = ['MD', 'BDO', 'MH', 'BH', 'SEX', 'TC'] as const;
export type SystemRole = typeof SYSTEM_ROLES[number];
const names: Record<SystemRole, string> = { MD: 'Managing Director', BDO: 'Business Development Officer',
  MH: 'Marketing Head', BH: 'Branch Head', SEX: 'Sales Executive', TC: 'Telecaller' };

export function defaultGrants(role: SystemRole): Grant[] {
  if (role === 'MD') return PERMISSION_CODES.map((permission) => ({ permission,
    scope: permissionDefinition(permission).allowedScopes.includes('ALL') ? 'ALL' : 'SELF' }));
  const grants: Grant[] = [];
  const add = (codes: PermissionCode[], scopes: DataScope[]) => {
    for (const permission of codes) for (const scope of scopes) grants.push({ permission, scope });
  };
  add(['users:read', 'hierarchy:read', 'attendance:read', 'reports:read', 'targets:read', 'dashboard:read'], ['SELF']);
  add(['attendance:create', 'reports:create', 'files:upload', 'files:read', 'notifications:read', 'notifications:update'], ['SELF']);
  add(['locations:read'], ['ALL']); add(['branches:read'], [role === 'BDO' || role === 'MH' ? 'REPORTING_SUBTREE' : 'BRANCH']);
  if (role === 'BDO' || role === 'MH' || role === 'BH') {
    const scope = role === 'BH' ? 'BRANCH' : 'REPORTING_SUBTREE';
    add(['users:read', 'hierarchy:read', 'users:create', 'users:update', 'users:deactivate', 'users:change_manager', 'users:transfer',
      'attendance:read', 'attendance:review', 'attendance:correct', 'customers:read', 'customers:assign', 'leads:create', 'leads:read',
      'leads:update', 'leads:assign', 'leads:propose_assignment', 'reports:read', 'reports:review',
      'targets:create', 'targets:read', 'targets:update', 'dashboard:read'], [scope]);
    if (role === 'BH') add(['branches:update'], ['BRANCH']);
    if (role === 'BDO' || role === 'MH') add(['leads:import', 'imports:create', 'imports:confirm', 'imports:read'], ['REPORTING_SUBTREE']);
  } else {
    add([role === 'TC' ? 'customers:receive_assignment' : 'leads:receive_assignment'], ['SELF']);
    add(role === 'TC' ? ['leads:create', 'leads:read'] : ['leads:create', 'leads:read', 'leads:update'], ['ASSIGNED']);
    if (role === 'TC') {
      add(['customers:read'], ['ASSIGNED']); add(['leads:read', 'leads:route'], ['SELF']);
    }
  }
  return grants;
}

export async function seedPermissions(session?: ClientSession): Promise<void> {
  for (const code of PERMISSION_CODES) {
    await PermissionModel.updateOne({ code }, { $set: permissionDefinition(code) }, { upsert: true, ...(session ? { session } : {}) });
  }
}

export async function seedSystemRoles(actorId: Types.ObjectId, session: ClientSession): Promise<Map<SystemRole, Types.ObjectId>> {
  await seedPermissions(session);
  const definitions = await PermissionModel.find().session(session).lean();
  const permissionIds = new Map(definitions.map((definition) => [definition.code, definition._id]));
  const roles = new Map<SystemRole, Types.ObjectId>();
  const roleId = (code: SystemRole): Types.ObjectId => {
    const id = roles.get(code); if (!id) throw new Error('System role missing'); return id;
  };
  for (const code of SYSTEM_ROLES) {
    const permissions = defaultGrants(code).map((grant) => ({ permissionId: permissionIds.get(grant.permission), scope: grant.scope }));
    const role = await RoleModel.findOneAndUpdate({ code }, { $setOnInsert: {
      name: names[code], code, permissions, isSystemRole: true, isActive: true, createdBy: actorId, revision: 0,
      allowsNoBranch: code === 'MD' || code === 'BDO' || code === 'MH',
    } }, { upsert: true, returnDocument: 'after', session, runValidators: true }).lean();
    if (!role.isSystemRole) throw new Error('Reserved system role code already used');
    roles.set(code, role._id);
  }
  const targets: Partial<Record<SystemRole, SystemRole[]>> = {
    MD: ['BDO', 'MH', 'BH', 'SEX', 'TC'], BDO: ['MH', 'BH', 'SEX', 'TC'], MH: ['BH', 'SEX', 'TC'], BH: ['SEX', 'TC'],
  };
  for (const creator of SYSTEM_ROLES) for (const target of targets[creator] ?? []) {
    const allowedManagerRoleIds = SYSTEM_ROLES.filter((candidate) => targets[candidate]?.includes(target)).map(roleId);
    await RolePolicyModel.updateOne({ creatorRoleId: roleId(creator), targetRoleId: roleId(target) }, { $setOnInsert: {
      allowedManagerRoleIds, branchRule: creator === 'BH' ? 'SAME_BRANCH' : 'EXPLICIT_SCOPE',
      allowCrossBranchReporting: creator === 'MD' || creator === 'BDO' || creator === 'MH', isActive: true, createdBy: actorId, revision: 0,
    } }, { upsert: true, session, runValidators: true });
  }
  return roles;
}
