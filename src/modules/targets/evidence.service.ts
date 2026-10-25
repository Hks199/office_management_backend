import { Types } from 'mongoose';
import type { Principal } from '../auth/auth.types.js';
import { OrganizationAccess } from '../../shared/services/organization-access.js';
import { ScopeService } from '../permissions/authorization.service.js';
import { leadAdapter } from '../leads/commercial-access.js';
import { LeadModel } from '../leads/commercial.models.js';
import { TargetEvidenceModel, TargetEvidenceReviewModel } from './target.model.js';
import { targetAdapter, milestoneAdapter } from './target.repository.js';
import { captureMilestone, type Milestone } from './target-evidence.js';
import type { EvidenceQuery, EvidenceReview } from './target.types.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { ClientSession } from 'mongoose';
const dto = <T extends { valueAtConversion?: Types.Decimal128 | null }>(record: T) => ({ ...record, valueAtConversion: record.valueAtConversion?.toString() ?? null });
export class TargetEvidenceService {
  private readonly access = new OrganizationAccess(); private readonly scopes = new ScopeService();
  private async scope(actor: Principal, action: 'reports:read' | 'reports:review', session?: ClientSession) {
    return { $and: [await this.scopes.predicate(actor, action, targetAdapter, session), await this.scopes.predicate(actor, 'leads:read', milestoneAdapter, session)] };
  }
  async list(actor: Principal, query: EvidenceQuery) {
    const match: Record<string, unknown> = {};
    for (const field of ['employeeId', 'branchId', 'leadId'] as const) if (query[field]) match[field] = new Types.ObjectId(query[field]);
    if (query.milestone) match.milestone = query.milestone; if (query.reviewStatus) match.reviewStatus = query.reviewStatus;
    const filter = { $and: [match, await this.scope(actor, 'reports:read')] };
    const [rows, total] = await Promise.all([TargetEvidenceModel.find(filter).sort({ occurredAt: query.sortOrder === 'asc' ? 1 : -1, _id: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean(), TargetEvidenceModel.countDocuments(filter)]);
    return { data: rows.map(dto), total };
  }
  async capture(actor: Principal, leadId: Types.ObjectId, milestone: Milestone, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'reports:review', session);
      if (!await LeadModel.exists({ $and: [{ _id: leadId }, await this.scopes.predicate(current, 'leads:read', leadAdapter, session)] }).session(session)) throw new AppError(404, 'NOT_FOUND', 'Lead not found');
      const record = await captureMilestone(leadId, milestone, current.userId, session, context);
      if (!record || !await TargetEvidenceModel.exists({ $and: [{ _id: record._id }, await this.scope(current, 'reports:review', session)] }).session(session)) throw new AppError(404, 'NOT_FOUND', 'Reviewable milestone not found');
      return dto(record);
    });
  }
  async review(actor: Principal, id: Types.ObjectId, input: EvidenceReview, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'reports:review', session);
      const previous = await TargetEvidenceModel.findOne({ $and: [{ _id: id }, await this.scope(current, 'reports:review', session)] }).session(session).lean();
      if (!previous) throw new AppError(404, 'NOT_FOUND', 'Target evidence not found');
      if (previous.employeeId.equals(current.userId) || previous.performedBy.equals(current.userId)) throw new AppError(403, 'SELF_REVIEW_FORBIDDEN', 'Another authorized employee must verify this milestone');
      if (input.reviewStatus === 'APPROVED' && previous.milestone === 'CONVERTED' && !previous.valueAtConversion) throw new AppError(409, 'MISSING_FROZEN_VALUE', 'Original conversion must have a frozen server value before approval');
      if (input.reviewStatus === 'APPROVED' && previous.milestone === 'CONVERTED' && !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/.test(previous.valueAtConversion?.toString() ?? '')) throw new AppError(409, 'INVALID_FROZEN_VALUE', 'Original conversion value must be nonnegative and expressed to at most two fractional digits');
      const record = await TargetEvidenceModel.findOneAndUpdate({ _id: id, revision: input.revision }, { $set: { reviewStatus: input.reviewStatus, remarks: input.remarks, reviewedBy: current.userId, reviewedAt: new Date() }, $inc: { revision: 1 } }, { session, returnDocument: 'after', runValidators: true }).lean();
      if (!record) throw new AppError(409, 'CONFLICT', 'Evidence changed; reload its revision');
      await TargetEvidenceReviewModel.create([{ evidenceId: id, actorId: current.userId, revision: record.revision, before: previous.reviewStatus, after: input.reviewStatus, remarks: input.remarks }], { session });
      await audit(session, context, 'TARGET_EVIDENCE_REVIEWED', current.userId, 'target_evidence', id, { before: previous.reviewStatus, after: input.reviewStatus, revision: String(record.revision) }); return dto(record);
    });
  }
  async history(actor: Principal, id: Types.ObjectId, page: number, limit: number) {
    if (!await TargetEvidenceModel.exists({ $and: [{ _id: id }, await this.scope(actor, 'reports:read')] })) throw new AppError(404, 'NOT_FOUND', 'Target evidence not found');
    const [data, total] = await Promise.all([TargetEvidenceReviewModel.find({ evidenceId: id }).sort({ revision: -1 }).skip((page - 1) * limit).limit(limit).lean(), TargetEvidenceReviewModel.countDocuments({ evidenceId: id })]); return { data, total };
  }
}
