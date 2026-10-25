import { createHash } from 'node:crypto';
import { Types, trusted, type ClientSession } from 'mongoose';
import type { Principal } from '../auth/auth.types.js';
import { OrganizationAccess } from '../../shared/services/organization-access.js';
import { ScopeService } from '../permissions/authorization.service.js';
import { CommercialAccess, commercialAdapter, leadAdapter } from '../leads/commercial-access.js';
import { CustomerModel, LeadModel, LeadEventModel, WorkflowModel } from '../leads/commercial.models.js';
import { BranchModel } from '../branches/branch.model.js';
import { terminalStatuses } from '../leads/workflow.service.js';
import { projectValue } from '../leads/decimal.js';
import { businessDate } from '../../shared/utils/business-date.js';
import { AppError } from '../../shared/errors/app-error.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
import { FileModel } from '../files/file.model.js';
import { ReportModel, ReportHistoryModel } from './report.model.js';
import type { CallInput, VisitInput, CompleteInput, ReviewInput, ReportQuery, Location } from './report.validator.js';
import { ReportRepository, reportDto } from './report.repository.js';
import { commercialFilter } from '../leads/commercial.repository.js';
import type { CommercialQuery } from '../leads/commercial.types.js';
export { reportDto } from './report.repository.js';
export type ReportKind = 'CALL' | 'VISIT';
export const reportAdapter = { ownerField: 'employeeId', branchField: 'branchId' } as const;
export function visitFlags(location: Location, captured: string, now: Date): string[] {
  const flags: string[] = []; const age = now.getTime() - new Date(captured).getTime();
  if (age > 300000 || age < -60000) flags.push('CAPTURE_TIME_SKEW');
  if (location.accuracyMeters === undefined) flags.push('ACCURACY_MISSING');
  else if (location.accuracyMeters > 100) flags.push('LOW_GPS_ACCURACY');
  return flags;
}
const hash = (values: unknown[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const locationValues = (value: Location) => [value.latitude, value.longitude, value.accuracyMeters ?? null];
function followUp(value: string | null | undefined, now: Date): Date | null {
  if (!value) return null; const date = new Date(value);
  if (date <= now || date.getTime() > now.getTime() + 366 * 86400000) throw new AppError(400, 'INVALID_FOLLOW_UP', 'Follow-up must be in the future and within one year');
  return date;
}
export class ReportService {
  readonly access = new OrganizationAccess(); readonly scopes = new ScopeService(); private readonly commercial = new CommercialAccess();
  private readonly repository = new ReportRepository();
  private async callContactScope(actor: Principal, session?: ClientSession) {
    this.commercial.authorization.require(actor, 'reports:create');
    const readable = await this.scopes.predicate(actor, 'customers:read', commercialAdapter, session);
    const assigned: Record<string, unknown>[] = [{ assignedTo: actor.userId }];
    const manager = { ...actor, grants: actor.grants.filter(grant => grant.permission === 'reports:review' && ['ALL', 'BRANCH', 'DIRECT_REPORTS', 'REPORTING_SUBTREE'].includes(grant.scope)) };
    if (manager.grants.length) assigned.push(await this.scopes.predicate(manager, 'reports:review', { hierarchyField: 'assignedTo', branchField: 'branchId' }, session));
    return { $and: [readable, { assignedTo: trusted({ $ne: null }), status: trusted({ $in: ['INTERESTED', 'AVAILABLE'] }) }, { $or: assigned }] };
  }
  async contactOptions(actor: Principal, query: CommercialQuery) {
    const filter = commercialFilter(await this.callContactScope(actor), query);
    const [data, total] = await Promise.all([
      CustomerModel.find(filter).select('_id customerName').sort({ customerName: 1, _id: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      CustomerModel.countDocuments(filter),
    ]);
    return { data, total };
  }
  async assignedLead(actor: Principal, id: Types.ObjectId, session: ClientSession) {
    const lead = await LeadModel.findOne({ $and: [{ _id: id, assignedTo: actor.userId }, await this.scopes.predicate(actor, 'leads:read', leadAdapter, session)] }).session(session).lean();
    if (!lead) throw new AppError(404, 'NOT_FOUND', 'Assigned lead not found');
    await this.eligible(actor, lead.branchId, 'leads', session); return lead;
  }
  private async eligible(actor: Principal, branch: Types.ObjectId, kind: 'leads' | 'customers', session: ClientSession) {
    await this.commercial.recipient(actor.userId, branch, kind, session);
    if (!await BranchModel.exists({ _id: branch, isActive: true }).session(session)) throw new AppError(409, 'INVALID_BRANCH', 'Branch must be active');
  }
  async ownedVisit(actor: Principal, id: Types.ObjectId, session: ClientSession) {
    const visit = await ReportModel.findOne({ _id: id, kind: 'VISIT', employeeId: actor.userId, status: 'OPEN' }).session(session).lean();
    if (!visit?.leadId) throw new AppError(404, 'NOT_FOUND', 'Open visit not found');
    if (!visit.visitStartedAt || Date.now() - visit.visitStartedAt.getTime() > 86400000) throw new AppError(409, 'VISIT_EXPIRED', 'Visits must be submitted within 24 hours');
    await this.assignedLead(actor, visit.leadId, session); return visit;
  }
  private async event(id: Types.ObjectId, actor: Principal, action: 'CREATED' | 'SUBMITTED' | 'REVIEWED' | 'EXPIRED', revision: number, after: string, session: ClientSession, context: AuditContext, before = '', remarks = '') {
    await ReportHistoryModel.create([{ reportId: id, actorId: actor.userId, action, revision, before, after, remarks }], { session });
    await audit(session, context, `REPORT_${action}`, actor.userId, 'report', id, { revision: String(revision), before, after });
  }
  async call(actor: Principal, input: CallInput, key: string, context: AuditContext) {
    // Outcome is authoritative; legacy clients may still send the removed interest field.
    const customerInterest = input.callOutcome === 'INTERESTED' || input.callOutcome === 'NOT_INTERESTED' ? input.callOutcome : 'UNKNOWN';
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'reports:create', session);
      const customer = await CustomerModel.findOne({ $and: [{ _id: new Types.ObjectId(input.customerId) }, await this.callContactScope(current, session)] }).session(session).lean();
      if (!customer) throw new AppError(404, 'NOT_FOUND', 'Assigned Available or Interested contact not found. Refresh the contact options.');
      if (customer.assignedTo.equals(current.userId)) await this.eligible(current, customer.branchId, 'customers', session);
      else if (!await BranchModel.exists({ _id: customer.branchId, isActive: true }).session(session)) throw new AppError(409, 'INVALID_BRANCH', 'Branch must be active');
      const requestHash = hash([input.customerId, input.callStartedAt, input.callEndedAt, input.callOutcome, customerInterest, input.followUpAt ?? null, input.remarks]);
      const existing = await ReportModel.findOne({ employeeId: current.userId, kind: 'CALL', idempotencyKey: key }).select('+requestHash').session(session).lean();
      if (existing) {
        if (existing.requestHash !== requestHash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Key already used for another call');
        return reportDto(existing);
      }
      const now = new Date(); const start = new Date(input.callStartedAt); const end = new Date(input.callEndedAt); const duration = end.getTime() - start.getTime();
      if (end > now || start.getTime() < now.getTime() - 7 * 86400000 || duration < 0 || duration > 4 * 3600000) throw new AppError(400, 'INVALID_CALL_INTERVAL', 'Calls require ordered non-future times within the last seven days and at most four hours');
      if (duration > 0 && await ReportModel.exists({ kind: 'CALL', employeeId: current.userId, callStartedAt: trusted({ $lt: end }), callEndedAt: trusted({ $gt: start }) }).session(session)) throw new AppError(409, 'CALL_OVERLAP', 'Call intervals cannot overlap your recorded calls');
      const [record] = await ReportModel.create([{ kind: 'CALL', employeeId: current.userId, branchId: customer.branchId, businessDate: businessDate(start),
        idempotencyKey: key, requestHash, customerId: customer._id, leadId: customer.leadId ?? null, customerName: customer.customerName, customerMobile: customer.mobileNumber, siteAddress: customer.siteAddress,
        callStartedAt: start, callEndedAt: end, callDurationSeconds: Math.floor(duration / 1000), callOutcome: input.callOutcome, customerInterest,
        followUpAt: followUp(input.followUpAt, now), remarks: input.remarks, convertedToLead: Boolean(customer.leadId), status: 'SUBMITTED' }], { session });
      if (!record) throw new Error('Call insertion failed');
      if (input.callOutcome === 'INTERESTED' && customer.status === 'AVAILABLE') {
        const changed = await CustomerModel.updateOne({ _id: customer._id, revision: customer.revision, status: 'AVAILABLE' },
          { $set: { status: 'INTERESTED' }, $inc: { revision: 1 } }, { session });
        if (changed.modifiedCount !== 1) throw new AppError(409, 'CONFLICT', 'Contact changed; refresh before recording the call');
        await audit(session, context, 'CUSTOMER_STATUS_CHANGED', current.userId, 'customer', customer._id,
          { before: 'AVAILABLE', after: 'INTERESTED', reason: 'Interested call outcome', reportId: record._id.toHexString() });
      }
      await this.event(record._id, current, 'CREATED', 0, 'SUBMITTED', session, context); return reportDto(record.toObject());
    });
  }
  async start(actor: Principal, input: VisitInput, key: string, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'reports:create', session); const lead = await this.assignedLead(current, new Types.ObjectId(input.leadId), session);
      const requestHash = hash([input.leadId, locationValues(input.location), input.clientCapturedAt]);
      const existing = await ReportModel.findOne({ employeeId: current.userId, kind: 'VISIT', idempotencyKey: key }).select('+requestHash').session(session).lean();
      if (existing) {
        if (existing.requestHash !== requestHash) throw new AppError(409, 'IDEMPOTENCY_CONFLICT', 'Key already used for another visit');
        return reportDto(existing);
      }
      if (terminalStatuses.includes(lead.status) || lead.status === 'ON_HOLD') throw new AppError(409, 'INACTIVE_LEAD', 'Visit requires an active lead');
      const now = new Date(); const date = businessDate(now);
      // Preserve abandoned evidence while allowing a new visit after the submission window.
      const expired = await ReportModel.findOneAndUpdate({ kind: 'VISIT', employeeId: current.userId, leadId: lead._id, status: 'OPEN',
        visitStartedAt: trusted({ $lt: new Date(now.getTime() - 86400000) }) }, { $set: { status: 'EXPIRED' }, $inc: { revision: 1 } }, { session, returnDocument: 'after' }).lean();
      if (expired) await this.event(expired._id, current, 'EXPIRED', expired.revision, 'EXPIRED', session, context, 'OPEN');
      const [record] = await ReportModel.create([{ kind: 'VISIT', employeeId: current.userId, salesExecutiveId: current.userId, branchId: lead.branchId, leadId: lead._id,
        businessDate: date, visitDate: date, idempotencyKey: key, requestHash, customerName: lead.customerName, customerMobile: lead.mobileNumber, siteAddress: lead.siteAddress,
        visitStartedAt: now, clientCapturedAt: new Date(input.clientCapturedAt), startLocation: input.location, location: input.location,
        point: { type: 'Point', coordinates: [input.location.longitude, input.location.latitude] }, evidenceFlags: visitFlags(input.location, input.clientCapturedAt, now), status: 'OPEN' }], { session });
      if (!record) throw new Error('Visit insertion failed');
      await this.event(record._id, current, 'CREATED', 0, 'OPEN', session, context); return reportDto(record.toObject());
    });
  }
  async complete(actor: Principal, id: Types.ObjectId, input: CompleteInput, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'reports:create', session); const visit = await this.ownedVisit(current, id, session);
      if (visit.revision !== input.revision || !visit.leadId) throw new AppError(409, 'CONFLICT', 'Visit changed; reload its revision');
      const lead = await this.assignedLead(current, visit.leadId, session);
      if (terminalStatuses.includes(lead.status) || lead.status === 'ON_HOLD') throw new AppError(409, 'INACTIVE_LEAD', 'Visit requires an active lead');
      const now = new Date(); const nextFollowUpAt = followUp(input.nextFollowUpAt, now);
      for (const fileId of input.photoFileIds) {
        const file = await FileModel.findOneAndUpdate({ _id: new Types.ObjectId(fileId), visitId: id, ownerId: current.userId, purpose: 'SITE_VISIT', status: 'READY',
          expiresAt: trusted({ $gt: now }), versionId: trusted({ $exists: true }) }, { $set: { status: 'ATTACHED' } }, { session }).lean();
        if (!file) throw new AppError(400, 'INVALID_PHOTO', 'Use fresh confirmed photos belonging to this visit');
      }
      const record = await ReportModel.findOneAndUpdate({ _id: id, revision: input.revision, status: 'OPEN' }, { $set: {
        status: 'SUBMITTED', visitCompletedAt: now, completedCapturedAt: new Date(input.clientCapturedAt), location: input.location,
        point: { type: 'Point', coordinates: [input.location.longitude, input.location.latitude] }, photoFileIds: input.photoFileIds.map((value) => new Types.ObjectId(value)),
        evidenceFlags: [...new Set([...visit.evidenceFlags, ...visitFlags(input.location, input.clientCapturedAt, now)])], discussionNotes: input.discussionNotes,
        customerInterest: input.customerInterest, installationReadiness: input.installationReadiness, visitOutcome: input.visitOutcome, requiredCapacityKw: input.requiredCapacityKw,
        ratePerKw: lead.ratePerKw, estimatedProjectValue: projectValue(input.requiredCapacityKw, lead.ratePerKw.toString()), nextFollowUpAt,
      }, $inc: { revision: 1 } }, { session, returnDocument: 'after', runValidators: true }).lean();
      if (!record) throw new AppError(409, 'CONFLICT', 'Visit changed; reload its revision');
      // Progress only the scheduled stage using this lead's pinned workflow and current update scope.
      if (current.grants.some((grant) => grant.permission === 'leads:update')) {
        const updateScope = await this.scopes.predicate(current, 'leads:update', leadAdapter, session);
        const allowed = await LeadModel.exists({ $and: [{ _id: lead._id }, updateScope] }).session(session);
        const workflow = await WorkflowModel.findOne({ version: lead.workflowVersion }).session(session).lean();
        const advance = input.visitOutcome === 'COMPLETED' && lead.status === 'SITE_VISIT_SCHEDULED' && workflow?.transitions.some((edge) => edge.from === lead.status && edge.to === 'SITE_VISITED');
        if (allowed && (advance || input.nextFollowUpAt !== undefined)) {
          await LeadModel.updateOne({ _id: lead._id, revision: lead.revision }, { $set: { ...(advance ? { status: 'SITE_VISITED' } : {}), ...(input.nextFollowUpAt !== undefined ? { nextFollowUpAt } : {}) }, $inc: { revision: 1 } }, { session });
          if (advance) await LeadEventModel.create([{ leadId: lead._id, fromStatus: lead.status, toStatus: 'SITE_VISITED', actorId: current.userId, workflowVersion: lead.workflowVersion, leadRevision: lead.revision + 1, reason: 'Site visit submitted' }], { session });
          await audit(session, context, 'LEAD_UPDATED_FROM_VISIT', current.userId, 'lead', lead._id, { reportId: id.toHexString(), stageAdvanced: String(Boolean(advance)), revision: String(lead.revision + 1) });
        }
      }
      await this.event(id, current, 'SUBMITTED', record.revision, 'SUBMITTED', session, context, 'OPEN'); return reportDto(record);
    });
  }
  private async filter(actor: Principal, kind: ReportKind, query: ReportQuery) {
    const match: Record<string, unknown> = { kind };
    for (const field of ['employeeId', 'customerId', 'leadId', 'branchId'] as const) if (query[field]) match[field] = new Types.ObjectId(query[field]);
    for (const field of ['callOutcome', 'visitOutcome', 'reviewStatus'] as const) if (query[field]) match[field] = query[field];
    if (query.from || query.to) match.businessDate = trusted({ ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) });
    return { $and: [match, await this.scopes.predicate(actor, 'reports:read', reportAdapter)] };
  }
  async list(actor: Principal, kind: ReportKind, query: ReportQuery) {
    return this.repository.list(await this.filter(actor, kind, query), query);
  }
  async get(actor: Principal, kind: ReportKind, id: Types.ObjectId, session?: ClientSession) {
    const report = await this.repository.get({ $and: [{ _id: id, kind }, await this.scopes.predicate(actor, 'reports:read', reportAdapter, session)] }, session);
    if (!report) throw new AppError(404, 'NOT_FOUND', 'Report not found'); return report;
  }
  async history(actor: Principal, kind: ReportKind, id: Types.ObjectId, query: ReportQuery) {
    await this.get(actor, kind, id); return this.repository.history(id, query);
  }
  async daily(actor: Principal, query: ReportQuery) {
    return this.repository.daily(await this.filter(actor, 'CALL', query), query);
  }
  async review(actor: Principal, kind: ReportKind, id: Types.ObjectId, input: ReviewInput, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'reports:review', session);
      const previous = await ReportModel.findOne({ $and: [{ _id: id, kind }, await this.scopes.predicate(current, 'reports:review', reportAdapter, session)] }).session(session).lean();
      if (!previous) throw new AppError(404, 'NOT_FOUND', 'Report not found');
      if (previous.employeeId.equals(current.userId)) throw new AppError(403, 'SELF_REVIEW_FORBIDDEN', 'Another authorized employee must review your report');
      if (previous.status !== 'SUBMITTED') throw new AppError(409, 'REPORT_NOT_SUBMITTED', 'Complete the visit before review');
      const record = await ReportModel.findOneAndUpdate({ _id: id, revision: input.revision }, { $set: { reviewStatus: input.reviewStatus, reviewRemarks: input.remarks, reviewedBy: current.userId, reviewedAt: new Date() }, $inc: { revision: 1 } }, { session, returnDocument: 'after', runValidators: true }).lean();
      if (!record) throw new AppError(409, 'CONFLICT', 'Report changed; reload its revision');
      await this.event(id, current, 'REVIEWED', record.revision, input.reviewStatus, session, context, previous.reviewStatus, input.remarks); return reportDto(record);
    });
  }
}
