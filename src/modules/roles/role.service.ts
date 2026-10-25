import { Types, type ClientSession } from 'mongoose';
import { AppError } from '../../shared/errors/app-error.js';
import { ADMINISTRATOR_PERMISSIONS, isAdministrator, isPermissionCode, permissionDefinition, scopeCovers, type Grant, type PermissionCode } from '../../constants/permissions.js';
import { AuthorizationService } from '../permissions/authorization.service.js';
import { AuthRepository } from '../auth/auth.repository.js';
import type { Principal } from '../auth/auth.types.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
import { RoleRepository } from './role.repository.js';
import type { GrantInput, PolicyInput, PolicyQuery, RoleCreate, RoleQuery, RoleUpdate } from './role.types.js';
import { AdministratorRepository } from '../../shared/repositories/administrator.repository.js';
import { UserRepository } from '../users/user.repository.js';
import { BranchRepository } from '../branches/branch.repository.js';

const missing = () => new AppError(404, 'NOT_FOUND', 'Resource not found');
const conflict = () => new AppError(409, 'CONFLICT', 'Resource changed or is still referenced');
const protectedRole = () => new AppError(403, 'SYSTEM_ROLE_PROTECTED', 'System role security cannot be removed');
const ROOT_PERMISSIONS = ADMINISTRATOR_PERMISSIONS;

export class RoleService {
  private readonly authorization = new AuthorizationService();
  private readonly authRepository = new AuthRepository();
  constructor(private readonly repository = new RoleRepository()) {}

  private async actor(principal: Principal, action: PermissionCode, session: ClientSession): Promise<Principal> {
    await this.repository.lock(session);
    const user = await this.authRepository.lockUser(principal.userId, session);
    if (!user || user.authVersion !== principal.authVersion || !(await this.authRepository.activeSession(principal.sessionId, user._id, session))) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
    }
    const grants = await this.authorization.grants(user.roleId, session);
    if (!grants) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
    const current = { ...principal, roleId: user.roleId, branchId: user.branchId ?? null, grants };
    this.authorization.requireAll(current, action);
    return current;
  }

  private async validateGrants(actor: Principal, input: GrantInput[]): Promise<Grant[]> {
    this.authorization.requireAll(actor, 'permissions:assign');
    const definitions = await this.repository.permissions(input.map((grant) => new Types.ObjectId(grant.permissionId)));
    const byId = new Map(definitions.map((definition) => [definition._id.toHexString(), definition.code]));
    const seen = new Set<string>();
    return input.map((grant) => {
      const code = byId.get(grant.permissionId);
      if (!code || !isPermissionCode(code) || !permissionDefinition(code).allowedScopes.includes(grant.scope)) {
        throw new AppError(400, 'INVALID_PERMISSION', 'Unknown permission or unsupported scope');
      }
      const key = `${grant.permissionId}:${grant.scope}`;
      if (seen.has(key)) throw new AppError(400, 'DUPLICATE_GRANT', 'Duplicate permission grant');
      seen.add(key);
      if (permissionDefinition(code).sensitive || grant.scope === 'ALL') this.authorization.requireAll(actor, 'permissions:delegate_sensitive');
      if (!actor.grants.some((held) => held.permission === code && scopeCovers(held.scope, grant.scope))) {
        throw new AppError(403, 'PRIVILEGE_ESCALATION', 'Cannot delegate permissions beyond your own grants');
      }
      return { permission: code, scope: grant.scope };
    });
  }

  async list(principal: Principal, query: RoleQuery) { this.authorization.requireAll(principal, 'roles:read'); return this.repository.list(query); }
  async get(principal: Principal, id: Types.ObjectId) {
    this.authorization.requireAll(principal, 'roles:read');
    const role = await this.repository.role(id); if (!role) throw missing(); return role;
  }
  async permissions(principal: Principal) { this.authorization.requireAll(principal, 'permissions:read'); return this.repository.permissions(); }

  async create(principal: Principal, input: RoleCreate, context: AuditContext) {
    return this.repository.transaction(async (session) => {
      const actor = await this.actor(principal, 'roles:create', session);
      if (input.allowsNoBranch) this.authorization.requireAll(actor, 'permissions:delegate_sensitive');
      if (input.permissions.length) await this.validateGrants(actor, input.permissions);
      const role = await this.repository.create(input, actor.userId, session);
      await audit(session, context, 'ROLE_CREATED', actor.userId, 'role', role._id,
        { roleCode: role.code, grants: String(role.permissions.length) });
      return role;
    });
  }
  async update(principal: Principal, id: Types.ObjectId, input: RoleUpdate, context: AuditContext) {
    return this.repository.transaction(async (session) => {
      const actor = await this.actor(principal, 'roles:update', session);
      const previous = await this.repository.role(id, session); if (!previous) throw missing();
      if (input.revision !== previous.revision) throw conflict();
      if (input.isActive === false && previous.isSystemRole) throw protectedRole();
      if (input.isActive === false && await this.repository.referenced(id, session)) throw conflict();
      if (input.allowsNoBranch !== undefined) {
        this.authorization.requireAll(actor, 'permissions:delegate_sensitive');
        if (!input.allowsNoBranch && await new UserRepository().companyWideUsers(id, session)) throw conflict();
      }
      if (input.isActive === true && !previous.isActive && !input.permissions) {
        await this.validateGrants(actor, previous.permissions.map((grant) => ({
          permissionId: grant.permissionId.toHexString(), scope: grant.scope,
        })));
      }
      if (input.permissions) {
        const grants = await this.validateGrants(actor, input.permissions);
        if (previous.isSystemRole && previous.code === 'MD' && ROOT_PERMISSIONS.some((code) =>
          !grants.some((grant) => grant.permission === code && grant.scope === 'ALL'))) throw protectedRole();
        const beforeGrants = await this.authorization.grants(id, session);
        if (beforeGrants && isAdministrator(beforeGrants) && !isAdministrator(grants) &&
          await new UserRepository().activeRoleUsers(id, session) && !(await new AdministratorRepository().exists(session, undefined, id))) {
          throw new AppError(409, 'LAST_ADMINISTRATOR', 'At least one active administrator must remain');
        }
        if (!grants.some((grant) => grant.permission === 'branches:update' && ['ALL', 'BRANCH'].includes(grant.scope)) &&
          await new BranchRepository().headsWithRole(id, session)) throw new AppError(409, 'BRANCH_HEAD_IN_USE', 'Reassign branch heads before removing their authority');
      }
      const role = await this.repository.update(id, input, session); if (!role) throw conflict();
      await audit(session, context, input.permissions ? 'PERMISSION_CHANGED' : 'ROLE_UPDATED', actor.userId, 'role', id,
        { previousRevision: String(previous.revision), revision: String(role.revision),
          beforeGrants: previous.permissions.map((grant) => `${grant.permissionId.toHexString()}:${grant.scope}`).join(','),
          afterGrants: role.permissions.map((grant) => `${grant.permissionId.toHexString()}:${grant.scope}`).join(',') });
      return role;
    });
  }
  async archive(principal: Principal, id: Types.ObjectId, revision: number, context: AuditContext) {
    return this.repository.transaction(async (session) => {
      const actor = await this.actor(principal, 'roles:delete', session);
      const previous = await this.repository.role(id, session); if (!previous) throw missing();
      if (previous.isSystemRole) throw protectedRole();
      if (previous.revision !== revision || await this.repository.referenced(id, session)) throw conflict();
      const role = await this.repository.update(id, { revision, isActive: false }, session); if (!role) throw conflict();
      await audit(session, context, 'ROLE_ARCHIVED', actor.userId, 'role', id);
      return role;
    });
  }
  async policies(principal: Principal, query: PolicyQuery) {
    this.authorization.requireAll(principal, 'policies:manage'); return this.repository.policies(query);
  }
  async savePolicy(principal: Principal, input: PolicyInput, context: AuditContext, id?: Types.ObjectId, revision?: number) {
    return this.repository.transaction(async (session) => {
      const actor = await this.actor(principal, 'policies:manage', session);
      this.authorization.requireAll(actor, 'permissions:delegate_sensitive');
      const previous = id ? await this.repository.policy(id, session) : null;
      if (id && !previous) throw missing();
      if (previous && previous.revision !== revision) throw conflict();
      let creatorRoleRevision = 0; let targetRoleRevision = 0;
      for (const roleId of [input.creatorRoleId, input.targetRoleId, ...input.allowedManagerRoleIds]) {
        const role = await this.repository.role(new Types.ObjectId(roleId), session);
        if (!role?.isActive) throw new AppError(400, 'INVALID_ROLE', 'Policy roles must be active');
        if (roleId === input.targetRoleId && role.code === 'MD') throw protectedRole();
        if (roleId === input.creatorRoleId) creatorRoleRevision = role.revision;
        if (roleId === input.targetRoleId) targetRoleRevision = role.revision;
      }
      if (input.creatorRoleId === input.targetRoleId) throw new AppError(400, 'INVALID_POLICY', 'Self-role creation is not allowed');
      if (previous) {
        const removedRelationship = !input.isActive || !previous.creatorRoleId.equals(input.creatorRoleId) || !previous.targetRoleId.equals(input.targetRoleId) ||
          !input.allowedManagerRoleIds.includes(input.creatorRoleId);
        if ((removedRelationship || !input.allowCrossBranchReporting) && await this.repository.reportingEdgeExists(previous.creatorRoleId,
          previous.targetRoleId, !removedRelationship, session)) {
          throw new AppError(409, 'REPORTING_POLICY_IN_USE', 'Reassign affected active reporting relationships before changing this policy');
        }
      }
      const approved = { ...input, creatorRoleRevision, targetRoleRevision };
      const policy = id ? await this.repository.updatePolicy(id, revision ?? -1, approved, session) :
        await this.repository.createPolicy(approved, actor.userId, session);
      if (!policy) throw conflict();
      await audit(session, context, 'ROLE_CREATION_POLICY_CHANGED', actor.userId, 'role_creation_policy', policy._id,
        { revision: String(policy.revision), before: previous ? JSON.stringify({
          creatorRoleId: previous.creatorRoleId, targetRoleId: previous.targetRoleId,
          allowedManagerRoleIds: previous.allowedManagerRoleIds, branchRule: previous.branchRule,
          allowCrossBranchReporting: previous.allowCrossBranchReporting, isActive: previous.isActive,
        }) : 'none', after: JSON.stringify(input) });
      return policy;
    });
  }
}
