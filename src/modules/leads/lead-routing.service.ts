import { Types, trusted } from 'mongoose';
import type { Principal } from '../auth/auth.types.js';
import { BranchModel } from '../branches/branch.model.js';
import { UserModel } from '../users/user.model.js';
import { RoleModel } from '../roles/role.model.js';
import { DistrictModel, StateModel } from '../locations/location.model.js';
import { OrganizationAccess } from '../../shared/services/organization-access.js';
import { CommercialAccess, leadAdapter } from './commercial-access.js';
import { LeadModel } from './commercial.models.js';
import { terminalStatuses } from './workflow.service.js';
import { literalPrefix } from '../../shared/utils/query.js';
import { AppError } from '../../shared/errors/app-error.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
import { leadDto } from './commercial.repository.js';

export interface LeadOptionQuery { page: number; limit: number; search?: string }
export class LeadRoutingService {
  private readonly access = new OrganizationAccess(); private readonly commercial = new CommercialAccess();
  async branches(actor: Principal, query: LeadOptionQuery) {
    this.commercial.authorization.require(actor, 'leads:create');
    const all = actor.grants.some((grant) => (grant.permission === 'leads:route' && ['SELF', 'ALL'].includes(grant.scope)) || (grant.permission === 'leads:create' && grant.scope === 'ALL'));
    const ids: Types.ObjectId[] = [];
    if (!all) for (const grant of actor.grants.filter((entry) => entry.permission === 'leads:create')) {
      if (['BRANCH', 'SELF', 'ASSIGNED'].includes(grant.scope) && actor.branchId) ids.push(actor.branchId);
      if (grant.scope === 'REPORTING_SUBTREE' || grant.scope === 'DIRECT_REPORTS') ids.push(...await this.commercial.scopes.leadBranches(actor.userId, grant.scope === 'DIRECT_REPORTS'));
    }
    const filter = { isActive: true, ...(!all ? { _id: trusted({ $in: ids }) } : {}),
      ...(query.search ? { $or: ['branchName', 'branchCode', 'address'].map((field) => ({ [field]: literalPrefix(query.search ?? '') })) } : {}) };
    const [branches, total] = await Promise.all([
      BranchModel.find(filter).select('_id branchName branchCode address stateId districtId').sort({ branchName: 1, _id: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      BranchModel.countDocuments(filter),
    ]);
    const [states, districts] = await Promise.all([
      StateModel.find({ _id: trusted({ $in: branches.map((branch) => branch.stateId) }) }).select('_id name').lean(),
      DistrictModel.find({ _id: trusted({ $in: branches.map((branch) => branch.districtId) }) }).select('_id name').lean(),
    ]);
    const stateNames = new Map(states.map((state) => [state._id.toHexString(), state.name]));
    const districtNames = new Map(districts.map((district) => [district._id.toHexString(), district.name]));
    return { data: branches.map((branch) => ({ _id: branch._id, branchName: branch.branchName, branchCode: branch.branchCode, address: branch.address,
      label: `${branch.branchName} (${branch.branchCode}) — ${districtNames.get(branch.districtId.toHexString()) ?? ''}, ${stateNames.get(branch.stateId.toHexString()) ?? ''}` })), total };
  }
  async assignees(actor: Principal, id: Types.ObjectId, query: LeadOptionQuery) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'leads:assign', session);
      const lead = await LeadModel.findOne({ $and: [{ _id: id }, await this.commercial.scopes.predicate(current, 'leads:assign', leadAdapter, session),
        await this.commercial.scopes.predicate(current, 'leads:read', leadAdapter, session)] }).session(session).lean();
      if (!lead) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
      if (terminalStatuses.includes(lead.status)) throw new AppError(409, 'TERMINAL_LEAD', 'Reopen the lead before assignment');
      const role = await RoleModel.findOne({ code: 'SEX', isActive: true }).session(session).lean();
      const grants = role ? await this.commercial.authorization.grants(role._id, session) : null;
      if (!role || !grants?.some((grant) => grant.permission === 'leads:receive_assignment') || !grants.some((grant) => grant.permission === 'leads:read' && ['ASSIGNED', 'ALL', 'BRANCH'].includes(grant.scope))) return { data: [], total: 0 };
      const destinations: Record<string, unknown>[] = [];
      for (const grant of current.grants.filter((entry) => entry.permission === 'leads:assign')) {
        if (grant.scope === 'ALL' || (grant.scope === 'BRANCH' && current.branchId?.equals(lead.branchId))) { destinations.push({}); break; }
        if (grant.scope === 'DIRECT_REPORTS' || grant.scope === 'REPORTING_SUBTREE') {
          if ((await this.commercial.scopes.leadBranches(current.userId, grant.scope === 'DIRECT_REPORTS', session)).some((branch) => branch.equals(lead.branchId))) { destinations.push({}); break; }
          destinations.push({ _id: trusted({ $in: await this.commercial.scopes.descendants(current.userId, grant.scope === 'DIRECT_REPORTS', session) }) });
        }
        if (['SELF', 'ASSIGNED'].includes(grant.scope) && current.branchId?.equals(lead.branchId)) destinations.push({ _id: current.userId });
      }
      if (!destinations.length) return { data: [], total: 0 };
      const filter: Record<string, unknown> = { $and: [{ branchId: lead.branchId, roleId: role._id, isActive: true, employmentStatus: 'ACTIVE' }, { $or: destinations },
        ...(query.search ? [{ $or: ['firstName', 'lastName', 'employeeCode'].map((field) => ({ [field]: literalPrefix(query.search ?? '') })) }] : [])] };
      const users = await UserModel.find(filter).select('_id firstName lastName employeeCode').sort({ firstName: 1, _id: 1 })
        .skip((query.page - 1) * query.limit).limit(query.limit).session(session).lean();
      return { data: users, total: await UserModel.countDocuments(filter).session(session) };
    });
  }
  async route(actor: Principal, id: Types.ObjectId, input: { revision: number; branchId: string; reason: string }, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'leads:route', session);
      const lead = await LeadModel.findOne({ $and: [{ _id: id }, await this.commercial.scopes.predicate(current, 'leads:route', leadAdapter, session)] }).session(session).lean();
      if (!lead) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
      if (lead.assignedTo || terminalStatuses.includes(lead.status)) throw new AppError(409, 'LEAD_ALREADY_ASSIGNED', 'Only unassigned, open leads can be routed to a branch');
      const branchId = new Types.ObjectId(input.branchId);
      if (!await BranchModel.exists({ _id: branchId, isActive: true }).session(session)) throw new AppError(400, 'INVALID_BRANCH', 'Select an active receiving branch');
      const record = await LeadModel.findOneAndUpdate({ _id: id, revision: input.revision, assignedTo: null }, { $set: { branchId, routedBy: current.userId, routedAt: new Date() }, $inc: { revision: 1 } }, { session, returnDocument: 'after' }).lean();
      if (!record) throw new AppError(409, 'CONFLICT', 'Lead changed; reload it before routing');
      await audit(session, context, 'LEAD_ROUTED_TO_BRANCH', current.userId, 'lead', id, { previousBranchId: lead.branchId.toHexString(), branchId: input.branchId, reason: input.reason });
      return leadDto(record);
    });
  }
}
