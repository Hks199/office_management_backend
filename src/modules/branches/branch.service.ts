import { requireManagingDirector } from '../../shared/services/md-access.js';
import { Types } from 'mongoose';
import type { Principal } from '../auth/auth.types.js';
import { AuthorizationService, ScopeService } from '../permissions/authorization.service.js';
import { BranchRepository } from './branch.repository.js';
import { LocationService } from '../locations/location.service.js';
import { OrganizationAccess } from '../../shared/services/organization-access.js';
import { AppError } from '../../shared/errors/app-error.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
import type { BranchInput, BranchQuery, BranchUpdate } from './branch.types.js';

export class BranchService {
  private readonly access = new OrganizationAccess(); private readonly scopes = new ScopeService();
  private readonly authorization = new AuthorizationService(); private readonly locations = new LocationService();
  constructor(private readonly repository = new BranchRepository()) {}
  private readonly adapter = { branchField: '_id', hierarchyBranches: true } as const;
  async list(actor: Principal, query: BranchQuery) { return this.repository.list(await this.scopes.predicate(actor, 'branches:read', this.adapter), query); }
  async get(actor: Principal, id: Types.ObjectId) {
    const branch = await this.repository.get(id, await this.scopes.predicate(actor, 'branches:read', this.adapter));
    if (!branch) throw new AppError(404, 'NOT_FOUND', 'Branch not found'); return branch;
  }
  async create(actor: Principal, input: BranchInput, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'branches:create', session); this.authorization.requireAll(current, 'branches:create');
      if (input.attendancePolicy !== undefined) await requireManagingDirector(current, session);
      await this.locations.assertChain(input, session);
      const branch = await this.repository.create(input, current.userId, session);
      await audit(session, context, 'BRANCH_CREATED', current.userId, 'branch', branch._id, { branchCode: branch.branchCode }); return branch;
    });
  }
  async update(actor: Principal, id: Types.ObjectId, input: BranchUpdate, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'branches:update', session);
      if (input.attendancePolicy !== undefined) await requireManagingDirector(current, session);
      const previous = await this.repository.get(id, await this.scopes.predicate(current, 'branches:update', this.adapter, session), session);
      if (!previous) throw new AppError(404, 'NOT_FOUND', 'Branch not found');
      if (input.stateId !== undefined || input.districtId !== undefined || input.blockId !== undefined || input.isActive !== undefined || input.attendancePolicy !== undefined) {
        this.authorization.requireAll(current, 'branches:update');
      }
      await this.locations.assertChain({ stateId: input.stateId ?? previous.stateId.toHexString(), districtId: input.districtId ?? previous.districtId.toHexString(),
        blockId: input.blockId === undefined ? previous.blockId?.toHexString() ?? null : input.blockId }, session);
      if (input.isActive === false && (previous.branchHeadId || await this.repository.activeEmployees(id, session))) {
        throw new AppError(409, 'BRANCH_IN_USE', 'Reassign the branch head and active employees first');
      }
      const { revision, ...changes } = input; const branch = await this.repository.update(id, revision, changes, session);
      if (!branch) throw new AppError(409, 'CONFLICT', 'Branch changed; reload its revision');
      await audit(session, context, 'BRANCH_UPDATED', current.userId, 'branch', id, {
        previousRevision: String(previous.revision), revision: String(branch.revision),
        before: JSON.stringify({ stateId: previous.stateId, districtId: previous.districtId, blockId: previous.blockId, isActive: previous.isActive }),
        after: JSON.stringify({ stateId: branch.stateId, districtId: branch.districtId, blockId: branch.blockId, isActive: branch.isActive }),
        previousAttendancePolicy: JSON.stringify(previous.attendancePolicy), attendancePolicy: JSON.stringify(branch.attendancePolicy),
      }); return branch;
    });
  }
  async head(actor: Principal, id: Types.ObjectId, revision: number, employeeId: string | null, reason: string, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'branches:assign_head', session); this.authorization.requireAll(current, 'branches:assign_head');
      const previous = await this.repository.get(id, {}, session); if (!previous) throw new AppError(404, 'NOT_FOUND', 'Branch not found');
      if (employeeId) {
        const user = await this.repository.headEmployee(new Types.ObjectId(employeeId), session);
        const grants = user ? await this.authorization.grants(user.roleId, session) : null;
        if (!previous.isActive || !user?.branchId?.equals(id) || user.employmentStatus === 'EXITED' ||
          !grants?.some((grant) => grant.permission === 'branches:update' && ['ALL', 'BRANCH'].includes(grant.scope))) {
          throw new AppError(400, 'INVALID_BRANCH_HEAD', 'Head must be an active branch employee with branch-management authority');
        }
      }
      const branch = await this.repository.update(id, revision, { branchHeadId: employeeId ? new Types.ObjectId(employeeId) : null }, session);
      if (!branch) throw new AppError(409, 'CONFLICT', 'Branch changed; reload its revision');
      await audit(session, context, 'BRANCH_HEAD_CHANGED', current.userId, 'branch', id,
        { before: previous.branchHeadId?.toHexString() ?? 'none', after: employeeId ?? 'none', reason }); return branch;
    });
  }
}
