import { createHash, randomUUID } from 'node:crypto';
import { Types, type ClientSession } from 'mongoose';
import type { Principal } from '../auth/auth.types.js';
import { LeadModel, CustomerModel, ReferenceModel, AssignmentModel, LeadEventModel, ProposalModel, IdempotencyModel, WorkflowModel, LEAD_STATUSES } from './commercial.models.js';
import type { LeadInput, LeadUpdate, Requirements, ConversionInput, CommercialQuery, AssignmentInput, StatusInput } from './commercial.types.js';
import { CommercialAccess, commercialAdapter, leadAdapter } from './commercial-access.js';
import { listCommercial, leadDto, withLeadLabels } from './commercial.repository.js';
import { currentWorkflow, terminalStatuses } from './workflow.service.js';
import { projectValue } from './decimal.js';
import { LocationService } from '../locations/location.service.js';
import { BranchModel } from '../branches/branch.model.js';
import { OrganizationAccess } from '../../shared/services/organization-access.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
import { AppError } from '../../shared/errors/app-error.js';
import { captureMilestone } from '../targets/target-evidence.js';
import { confirmCustomer } from '../sales-customers/customer-lifecycle.js';
import { ConfirmedCustomerModel } from '../sales-customers/customer.model.js';
import { withEmployeeLabels } from '../../shared/services/employee-labels.js';
export class LeadService {
  private readonly access = new OrganizationAccess(); private readonly commercial = new CommercialAccess(); private readonly locations = new LocationService();
  private canChooseAssignedStatus(actor: Principal, lead: { assignedTo?: Types.ObjectId | null | undefined }) {
    return Boolean(lead.assignedTo?.equals(actor.userId)) && actor.grants.some(grant => grant.permission === 'leads:receive_assignment');
  }
  async statusOptions(actor: Principal, id: Types.ObjectId) {
    const lead = await LeadModel.findOne({ $and: [{ _id: id }, await this.commercial.scopes.predicate(actor, 'leads:read', leadAdapter), await this.commercial.scopes.predicate(actor, 'leads:update', leadAdapter)] }).lean();
    if (!lead) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
    const workflow = await WorkflowModel.findOne({ version: lead.workflowVersion }).lean();
    if (!workflow) throw new AppError(503, 'COMMERCIAL_NOT_INITIALIZED', 'The lead workflow is unavailable');
    const flexible = this.canChooseAssignedStatus(actor, lead);
    let allowedStatuses = flexible ? [...LEAD_STATUSES] : workflow.transitions.filter(edge => edge.from === lead.status).map(edge => edge.to);
    if (terminalStatuses.includes(lead.status)) {
      const canReopen = actor.grants.some(grant => grant.permission === 'leads:reopen') && await LeadModel.exists({ $and: [{ _id: id }, await this.commercial.scopes.predicate(actor, 'leads:reopen', leadAdapter)] });
      allowedStatuses = canReopen ? ['CONTACTED'] : [];
    } else if (lead.status === 'ON_HOLD' && !flexible) allowedStatuses = lead.resumeStatus ? [lead.resumeStatus] : [];
    return { currentStatus: lead.status, revision: lead.revision, workflowVersion: lead.workflowVersion,
      allowedStatuses: [...new Set(allowedStatuses)].filter(status => status !== lead.status && (status !== 'CONVERTED' || Boolean(lead.assignedTo))) };
  }
  async list(actor: Principal, query: CommercialQuery) { return listCommercial('leads', await this.commercial.scopes.predicate(actor, 'leads:read', leadAdapter), query); }
  async get(actor: Principal, id: Types.ObjectId, session?: ClientSession) {
    const lead = await LeadModel.findOne({ $and: [{ _id: id }, await this.commercial.scopes.predicate(actor, 'leads:read', leadAdapter, session)] }).session(session ?? null).lean();
    if (!lead) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
    const customer = await ConfirmedCustomerModel.findOne({ leadId: lead._id }).select('_id customerCode').session(session ?? null).lean();
    return { ...leadDto(lead), ...(await withLeadLabels([leadDto(lead)], session))[0], confirmedCustomerId: customer?._id ?? null, confirmedCustomerCode: customer?.customerCode ?? null };
  }
  private async references(input: Partial<Requirements>, session: ClientSession) {
    for (const [field, category] of [['paymentMode', 'PAYMENT_MODE'], ['panelBrand', 'PANEL_BRAND'], ['panelTechnology', 'PANEL_TECHNOLOGY'], ['leadSource', 'LEAD_SOURCE']] as const) {
      if (input[field] !== undefined && !await ReferenceModel.exists({ category, code: input[field], isActive: true }).session(session)) throw new AppError(400, 'INVALID_REFERENCE', 'Select active configured lead references');
    }
  }
  private async insert(actor: Principal, input: LeadInput, session: ClientSession, context: AuditContext, sourceCustomerId: Types.ObjectId | null = null) {
    await this.references(input, session); await this.locations.assertChain(input, session);
    const workflow = await currentWorkflow(session); const now = new Date(); const assignedTo = input.assignedTo ? new Types.ObjectId(input.assignedTo) : null;
    const [record] = await LeadModel.create([{ ...input, sourceCustomerId, leadCode: `SV-${randomUUID().toUpperCase()}`, assignedTo,
      assignedBy: assignedTo ? actor.userId : null, assignedAt: assignedTo ? now : null, salesExecutiveId: assignedTo,
      telecallerId: sourceCustomerId || actor.grants.some((grant) => grant.permission === 'leads:route' && grant.scope === 'SELF') ? actor.userId : null, createdBy: actor.userId, workflowVersion: workflow.version,
      estimatedProjectValue: projectValue(input.requiredCapacityKw, input.ratePerKw),
      routedBy: assignedTo ? null : actor.userId, routedAt: assignedTo ? null : now,
    }], { session });
    if (!record) throw new Error('Lead insertion failed');
    await LeadEventModel.create([{ leadId: record._id, toStatus: 'NEW', actorId: actor.userId, workflowVersion: workflow.version, leadRevision: 0 }], { session });
    if (assignedTo) await AssignmentModel.create([{ entityId: record._id, entityType: 'LEAD', assignedTo, assignedBy: actor.userId, reason: 'Initial assignment', entityRevision: 0 }], { session });
    await captureMilestone(record._id, 'CREATED', actor.userId, session, context);
    await audit(session, context, 'LEAD_CREATED', actor.userId, 'lead', record._id, { branchId: record.branchId.toHexString(), sourceCustomerId: sourceCustomerId?.toHexString() ?? 'none' });
    return record.toObject();
  }
  async create(actor: Principal, input: LeadInput, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'leads:create', session); const branchId = new Types.ObjectId(input.branchId);
      const assignedTo = input.assignedTo ? new Types.ObjectId(input.assignedTo) : null;
      if (assignedTo) await this.commercial.recipient(assignedTo, branchId, 'leads', session);
      if (!assignedTo && current.grants.some((grant) => grant.permission === 'leads:route' && ['SELF', 'ALL'].includes(grant.scope))) {
        if (!await BranchModel.exists({ _id: branchId, isActive: true }).session(session)) throw new AppError(400, 'INVALID_BRANCH', 'Select an active receiving branch');
      } else await this.commercial.destination(current, 'leads:create', branchId, assignedTo, session);
      // Creating for another assignee additionally needs assignment authority.
      if (assignedTo && !assignedTo.equals(current.userId)) await this.commercial.destination(current, 'leads:assign', branchId, assignedTo, session);
      return leadDto(await this.insert(current, input, session, context));
    });
  }
  async update(actor: Principal, id: Types.ObjectId, input: LeadUpdate, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'leads:update', session);
      const previous = await LeadModel.findOne({ $and: [{ _id: id }, await this.commercial.scopes.predicate(current, 'leads:update', leadAdapter, session)] }).session(session).lean();
      if (!previous) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
      if (terminalStatuses.includes(previous.status)) throw new AppError(409, 'TERMINAL_LEAD', 'Reopen a terminal lead before editing');
      await this.references(input, session);
      if (input.stateId || input.districtId || input.blockId !== undefined) await this.locations.assertChain({ stateId: input.stateId ?? previous.stateId.toHexString(),
        districtId: input.districtId ?? previous.districtId.toHexString(), blockId: input.blockId === undefined ? previous.blockId?.toHexString() ?? null : input.blockId }, session);
      const { revision, ...changes } = input;
      const record = await LeadModel.findOneAndUpdate({ _id: id, revision }, { $set: { ...changes,
        estimatedProjectValue: projectValue(input.requiredCapacityKw ?? previous.requiredCapacityKw.toString(), input.ratePerKw ?? previous.ratePerKw.toString()),
      }, $inc: { revision: 1 } }, { session, returnDocument: 'after', runValidators: true }).lean();
      if (!record) throw new AppError(409, 'CONFLICT', 'Lead changed; reload its revision');
      await audit(session, context, 'LEAD_UPDATED', current.userId, 'lead', id, { fields: Object.keys(changes).join(','), revision: String(record.revision) }); return leadDto(record);
    });
  }
  async convert(actor: Principal, customerId: Types.ObjectId, input: ConversionInput, key: string, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'leads:create', session);
      const customer = await CustomerModel.findOne({ $and: [{ _id: customerId },
        await this.commercial.scopes.predicate(current, 'customers:read', commercialAdapter, session),
        await this.commercial.scopes.predicate(current, 'leads:create', commercialAdapter, session)] }).session(session).lean();
      if (!customer) throw new AppError(404, 'NOT_FOUND', 'Contact not found');
      const requirements = Object.entries(input.requirements).sort(([a], [b]) => a.localeCompare(b));
      const branchId = input.branchId ? new Types.ObjectId(input.branchId) : customer.branchId;
      const hash = createHash('sha256').update(JSON.stringify([customerId.toHexString(), input.revision, requirements, input.proposedSalesExecutiveId ?? null, branchId.toHexString()])).digest('hex');
      const existing = await IdempotencyModel.findOne({ actorId: current.userId, operation: 'CUSTOMER_CONVERT', key }).session(session).lean();
      if (existing) {
        if (existing.requestHash !== hash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was used with another request');
        return this.get(current, existing.entityId, session);
      }
      if (customer.status !== 'INTERESTED' || customer.leadId || customer.revision !== input.revision) throw new AppError(409, 'CUSTOMER_NOT_ELIGIBLE', 'Contact must be interested, unconverted and at the current revision');
      const proposedTo = input.proposedSalesExecutiveId ? new Types.ObjectId(input.proposedSalesExecutiveId) : null;
      if (proposedTo) {
        this.commercial.authorization.require(current, 'leads:assign');
        this.commercial.authorization.require(current, 'leads:propose_assignment');
        await this.commercial.recipient(proposedTo, branchId, 'leads', session);
      }
      if (!branchId.equals(customer.branchId) && !current.grants.some((grant) => grant.permission === 'leads:route' && ['SELF', 'ALL'].includes(grant.scope))) {
        await this.commercial.destination(current, 'leads:create', branchId, null, session);
      }
      if (!await BranchModel.exists({ _id: branchId, isActive: true }).session(session)) throw new AppError(400, 'INVALID_BRANCH', 'Branch must be active');
      const lead = await this.insert(current, { customerName: customer.customerName, mobileNumber: customer.mobileNumber, alternateNumber: customer.alternateNumber,
        stateId: customer.stateId.toHexString(), districtId: customer.districtId.toHexString(), blockId: customer.blockId?.toHexString() ?? null,
        tehsil: customer.tehsil, siteAddress: customer.siteAddress, remarks: customer.remarks, branchId: branchId.toHexString(), ...input.requirements,
      }, session, context, customerId);
      await CustomerModel.updateOne({ _id: customerId, revision: input.revision }, { $set: { status: 'CONVERTED', leadId: lead._id }, $inc: { revision: 1 } }, { session });
      if (proposedTo) await ProposalModel.create([{ leadId: lead._id, proposedTo, proposedBy: current.userId, leadRevision: lead.revision,
        reason: 'Contact conversion recommendation', expiresAt: new Date(Date.now() + 604800000) }], { session });
      await IdempotencyModel.create([{ actorId: current.userId, operation: 'CUSTOMER_CONVERT', key, requestHash: hash, entityId: lead._id, expiresAt: new Date(Date.now() + 2592000000) }], { session });
      await audit(session, context, 'CUSTOMER_CONVERTED', current.userId, 'customer', customerId, { leadId: lead._id.toHexString() }); return leadDto(lead);
    });
  }
  private async assignInTransaction(current: Principal, id: Types.ObjectId, input: AssignmentInput, session: ClientSession, context: AuditContext) {
    const previous = await LeadModel.findOne({ $and: [{ _id: id }, await this.commercial.scopes.predicate(current, 'leads:assign', leadAdapter, session)] }).session(session).lean();
    if (!previous) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
    if (terminalStatuses.includes(previous.status)) throw new AppError(409, 'TERMINAL_LEAD', 'Reopen terminal lead before assignment');
    const assignedTo = new Types.ObjectId(input.assignedTo); await this.commercial.recipient(assignedTo, previous.branchId, 'leads', session);
    await this.commercial.destination(current, 'leads:assign', previous.branchId, assignedTo, session);
    const record = await LeadModel.findOneAndUpdate({ _id: id, revision: input.revision }, { $set: { assignedTo, assignedBy: current.userId, assignedAt: new Date(),
      ...(previous.salesExecutiveId ? {} : { salesExecutiveId: assignedTo }) }, $inc: { revision: 1 } }, { session, returnDocument: 'after', runValidators: true }).lean();
    if (!record) throw new AppError(409, 'CONFLICT', 'Lead changed; reload its revision');
    await AssignmentModel.create([{ entityId: id, entityType: 'LEAD', previousAssigneeId: previous.assignedTo ?? null, assignedTo,
      assignedBy: current.userId, reason: input.reason, entityRevision: record.revision }], { session });
    await audit(session, context, 'LEAD_ASSIGNED', current.userId, 'lead', id, { before: previous.assignedTo?.toHexString() ?? 'none', after: input.assignedTo, reason: input.reason }); return leadDto(record);
  }
  async assign(actor: Principal, id: Types.ObjectId, input: AssignmentInput, context: AuditContext) {
    return this.access.transaction(async (session) => this.assignInTransaction(await this.access.actor(actor, 'leads:assign', session), id, input, session, context));
  }
  async propose(actor: Principal, id: Types.ObjectId, input: AssignmentInput, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'leads:propose_assignment', session);
      const lead = await LeadModel.findOne({ $and: [{ _id: id }, await this.commercial.scopes.predicate(current, 'leads:propose_assignment', leadAdapter, session),
        await this.commercial.scopes.predicate(current, 'leads:read', leadAdapter, session)] }).session(session).lean();
      if (!lead) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
      if (lead.revision !== input.revision || terminalStatuses.includes(lead.status)) throw new AppError(409, 'CONFLICT', 'Lead changed or is terminal');
      await this.commercial.recipient(new Types.ObjectId(input.assignedTo), lead.branchId, 'leads', session);
      // A manager's proposal cannot cross its destination scope; owner/assigned proposals are branch-local recommendations.
      if (!lead.createdBy.equals(current.userId) && !lead.assignedTo?.equals(current.userId)) await this.commercial.destination(current, 'leads:propose_assignment', lead.branchId, new Types.ObjectId(input.assignedTo), session);
      if (await ProposalModel.exists({ leadId: id, status: 'PENDING' }).session(session)) throw new AppError(409, 'PROPOSAL_PENDING', 'Resolve the pending proposal first');
      const [proposal] = await ProposalModel.create([{ leadId: id, proposedTo: input.assignedTo, proposedBy: current.userId, leadRevision: lead.revision,
        reason: input.reason, expiresAt: new Date(Date.now() + 604800000) }], { session });
      if (!proposal) throw new Error('Proposal insertion failed');
      await audit(session, context, 'LEAD_ASSIGNMENT_PROPOSED', current.userId, 'lead', id, { proposalId: proposal._id.toHexString() }); return proposal.toObject();
    });
  }
  async reviewProposal(actor: Principal, id: Types.ObjectId, input: { status: 'APPROVED' | 'REJECTED'; reason: string }, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'leads:assign', session);
      const proposal = await ProposalModel.findOne({ _id: id, status: 'PENDING' }).session(session).lean();
      if (!proposal) throw new AppError(404, 'NOT_FOUND', 'Pending proposal not found');
      const lead = await LeadModel.findOne({ $and: [{ _id: proposal.leadId }, await this.commercial.scopes.predicate(current, 'leads:assign', leadAdapter, session)] }).session(session).lean();
      if (!lead) throw new AppError(404, 'NOT_FOUND', 'Pending proposal not found');
      if (input.status === 'APPROVED') {
        if (proposal.expiresAt.getTime() <= Date.now() || lead.revision !== proposal.leadRevision) throw new AppError(409, 'STALE_PROPOSAL', 'Proposal expired or the lead changed; reject it and submit a new one');
        await this.assignInTransaction(current, lead._id, { revision: proposal.leadRevision, assignedTo: proposal.proposedTo.toHexString(), reason: input.reason }, session, context);
      }
      const record = await ProposalModel.findOneAndUpdate({ _id: id, status: 'PENDING' }, { $set: { status: input.status, reviewedBy: current.userId, reviewedAt: new Date(), reviewReason: input.reason } }, { session, returnDocument: 'after' }).lean();
      await audit(session, context, 'LEAD_PROPOSAL_REVIEWED', current.userId, 'lead', lead._id, { status: input.status, proposalId: id.toHexString(), reason: input.reason }); return record;
    });
  }
  async status(actor: Principal, id: Types.ObjectId, input: StatusInput, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'leads:update', session);
      const previous = await LeadModel.findOne({ $and: [{ _id: id }, await this.commercial.scopes.predicate(current, 'leads:update', leadAdapter, session)] }).session(session).lean();
      if (!previous) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
      const workflow = await WorkflowModel.findOne({ version: previous.workflowVersion }).session(session).lean();
      if (!previous.assignedTo && input.status === 'CONVERTED') throw new AppError(409, 'LEAD_NOT_ASSIGNED', 'Assign this lead to a sales executive before confirming the customer');
      const flexible = this.canChooseAssignedStatus(current, previous);
      let valid = flexible || (workflow?.transitions.some((edge) => edge.from === previous.status && edge.to === input.status) ?? false);
      if (terminalStatuses.includes(previous.status)) {
        const scope = await this.commercial.scopes.predicate(current, 'leads:reopen', leadAdapter, session);
        if (!await LeadModel.exists({ $and: [{ _id: id }, scope] }).session(session)) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
        valid = input.status === 'CONTACTED';
      } else if (previous.status === 'ON_HOLD' && !flexible) valid = input.status === previous.resumeStatus;
      if (!valid || previous.status === input.status) throw new AppError(400, 'INVALID_TRANSITION', 'Lead status transition is not allowed');
      const record = await LeadModel.findOneAndUpdate({ _id: id, revision: input.revision }, { $set: { status: input.status,
        resumeStatus: input.status === 'ON_HOLD' ? previous.status : null,
        ...(input.status === 'CONTACTED' ? { lastContactedAt: new Date() } : {}),
      }, $inc: { revision: 1 } }, { session, returnDocument: 'after', runValidators: true }).lean();
      if (!record) throw new AppError(409, 'CONFLICT', 'Lead changed; reload its revision');
      if (input.status === 'CONVERTED') await confirmCustomer(record, current.userId, session, context);
      else if (previous.status === 'CONVERTED') await ConfirmedCustomerModel.updateOne({ leadId: id }, { $set: { status: 'REVIEW_REQUIRED' } }, { session });
      await LeadEventModel.create([{ leadId: id, fromStatus: previous.status, toStatus: input.status, actorId: current.userId,
        workflowVersion: previous.workflowVersion, leadRevision: record.revision, reason: input.reason,
        valueAtConversion: input.status === 'CONVERTED' ? previous.estimatedProjectValue : null }], { session });
      if (input.status === 'QUALIFIED' || input.status === 'CONVERTED') await captureMilestone(id, input.status, current.userId, session, context);
      await audit(session, context, 'LEAD_STATUS_CHANGED', current.userId, 'lead', id, { before: previous.status, after: input.status, reason: input.reason, selectionPolicy: flexible ? 'ASSIGNED_EXECUTIVE' : 'WORKFLOW' }); return leadDto(record);
    });
  }
  async history(actor: Principal, id: Types.ObjectId, kind: 'assignments' | 'status' | 'proposals', query: CommercialQuery) {
    await this.get(actor, id);
    const pagination = { createdAt: query.sortOrder === 'asc' ? 1 as const : -1 as const, _id: 1 as const };
    if (kind === 'assignments') return withEmployeeLabels(await AssignmentModel.find({ entityType: 'LEAD', entityId: id }).sort(pagination).skip((query.page - 1) * query.limit).limit(query.limit).lean(), ['assignedTo', 'assignedBy', 'previousAssigneeId']);
    if (kind === 'proposals') return ProposalModel.find({ leadId: id }).sort(pagination).skip((query.page - 1) * query.limit).limit(query.limit).lean();
    const events = await LeadEventModel.find({ leadId: id }).sort(pagination).skip((query.page - 1) * query.limit).limit(query.limit).lean();
    return events.map((event) => ({ ...event, valueAtConversion: event.valueAtConversion?.toString() ?? null }));
  }
}
