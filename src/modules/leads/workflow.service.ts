import { Types, type ClientSession } from 'mongoose';
import type { Principal } from '../auth/auth.types.js';
import { WorkflowModel, ReferenceModel, CommercialSettingsModel, CustomerModel, type LeadStatus, type REFERENCE_CATEGORIES } from './commercial.models.js';
import { OrganizationAccess } from '../../shared/services/organization-access.js';
import { AuthorizationService } from '../permissions/authorization.service.js';
import { AppError } from '../../shared/errors/app-error.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
export const terminalStatuses: readonly LeadStatus[] = ['CONVERTED', 'LOST', 'NOT_INTERESTED'];
export const defaultTransitions: { from: LeadStatus; to: LeadStatus }[] = [
  ['NEW', 'ASSIGNED'], ['NEW', 'CONTACTED'], ['ASSIGNED', 'CONTACTED'], ['CONTACTED', 'INTERESTED'], ['CONTACTED', 'NOT_INTERESTED'],
  ['INTERESTED', 'QUALIFIED'], ['QUALIFIED', 'SITE_VISIT_SCHEDULED'], ['SITE_VISIT_SCHEDULED', 'SITE_VISITED'], ['SITE_VISITED', 'QUOTATION_SENT'],
  ['QUOTATION_SENT', 'NEGOTIATION'], ['QUOTATION_SENT', 'CONVERTED'], ['NEGOTIATION', 'CONVERTED'], ['NEGOTIATION', 'LOST'],
].map(([from, to]) => ({ from: from as LeadStatus, to: to as LeadStatus }));
for (const from of ['NEW', 'ASSIGNED', 'CONTACTED', 'INTERESTED', 'QUALIFIED', 'SITE_VISIT_SCHEDULED', 'SITE_VISITED', 'QUOTATION_SENT', 'NEGOTIATION'] as const) {
  for (const to of ['LOST', 'ON_HOLD'] as const) if (!defaultTransitions.some((edge) => edge.from === from && edge.to === to)) defaultTransitions.push({ from, to });
}
export async function currentWorkflow(session?: ClientSession) {
  const workflow = await WorkflowModel.findOne().sort({ version: -1 }).session(session ?? null).lean();
  if (!workflow) throw new AppError(503, 'COMMERCIAL_NOT_INITIALIZED', 'Run the commercial index/setup migration'); return workflow;
}
export class WorkflowService {
  private readonly access = new OrganizationAccess(); private readonly authorization = new AuthorizationService();
  async listReferences(actor: Principal, category: typeof REFERENCE_CATEGORIES[number], isActive: boolean) {
    this.authorization.requireAll(actor, 'locations:read'); return ReferenceModel.find({ category, isActive }).sort({ code: 1 }).limit(500).lean();
  }
  async reference(actor: Principal, input: { category: typeof REFERENCE_CATEGORIES[number]; code: string; label: string }, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'settings:manage', session); this.authorization.requireAll(current, 'settings:manage');
      const [record] = await ReferenceModel.create([{ ...input, createdBy: current.userId }], { session }); if (!record) throw new Error('Reference insertion failed');
      await audit(session, context, 'REFERENCE_CREATED', current.userId, 'reference', record._id, { category: input.category, code: input.code }); return record.toObject();
    });
  }
  async updateReference(actor: Principal, id: Types.ObjectId, input: { revision: number; label?: string; isActive?: boolean }, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'settings:manage', session); this.authorization.requireAll(current, 'settings:manage');
      const { revision, ...changes } = input;
      const record = await ReferenceModel.findOneAndUpdate({ _id: id, revision }, { $set: changes, $inc: { revision: 1 } }, { session, returnDocument: 'after', runValidators: true }).lean();
      if (!record) throw new AppError(409, 'CONFLICT', 'Reference changed or is unavailable');
      await audit(session, context, 'REFERENCE_UPDATED', current.userId, 'reference', id, { revision: String(record.revision) }); return record;
    });
  }
  async workflow(actor: Principal) { this.authorization.require(actor, 'leads:read'); return currentWorkflow(); }
  async saveWorkflow(actor: Principal, input: { expectedVersion: number; transitions: { from: LeadStatus; to: LeadStatus }[] }, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'settings:manage', session); this.authorization.requireAll(current, 'settings:manage');
      const previous = await currentWorkflow(session);
      if (previous.version !== input.expectedVersion) throw new AppError(409, 'CONFLICT', 'Workflow version changed');
      if (input.transitions.some((edge) => edge.from === edge.to || terminalStatuses.includes(edge.from) || edge.from === 'ON_HOLD' || edge.to === 'NEW')) throw new AppError(400, 'INVALID_WORKFLOW', 'Terminal reopen and hold/resume use controlled transitions');
      const [record] = await WorkflowModel.create([{ version: previous.version + 1, transitions: input.transitions, createdBy: current.userId }], { session });
      if (!record) throw new Error('Workflow insertion failed');
      await audit(session, context, 'LEAD_WORKFLOW_CREATED', current.userId, 'workflow', record._id, { version: String(record.version) }); return record.toObject();
    });
  }
  async settings(actor: Principal) { this.authorization.requireAll(actor, 'settings:manage'); return CommercialSettingsModel.findById('customers').lean(); }
  async saveSettings(actor: Principal, input: { revision: number; duplicateScope: 'BRANCH' | 'COMPANY' }, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'settings:manage', session); this.authorization.requireAll(current, 'settings:manage');
      if (await CustomerModel.exists({}).session(session)) throw new AppError(409, 'DEDUPE_POLICY_LOCKED', 'Duplicate policy cannot change after contact data exists');
      const record = await CommercialSettingsModel.findOneAndUpdate({ _id: 'customers', revision: input.revision }, { $set: { duplicateScope: input.duplicateScope }, $inc: { revision: 1 } }, { session, returnDocument: 'after' }).lean();
      if (!record) throw new AppError(409, 'CONFLICT', 'Duplicate settings changed or are not initialized');
      await audit(session, context, 'CUSTOMER_DEDUPE_POLICY_CHANGED', current.userId, 'settings', null, { duplicateScope: input.duplicateScope }); return record;
    });
  }
}
