import { Types, trusted, type ClientSession } from 'mongoose';
import { LeadModel, LeadEventModel, AssignmentModel } from '../leads/commercial.models.js';
import { TargetEvidenceModel } from './target.model.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
export type Milestone = 'CREATED' | 'QUALIFIED' | 'CONVERTED';
// Derive attribution from immutable event/assignment revisions, including pre-Phase-7 history.
export async function captureMilestone(leadId: Types.ObjectId, milestone: Milestone, actorId: Types.ObjectId, session: ClientSession, context: AuditContext) {
  const existing = await TargetEvidenceModel.findOne({ leadId, milestone }).session(session).lean(); if (existing) return existing;
  const status = milestone === 'CREATED' ? 'NEW' : milestone;
  const event = await LeadEventModel.findOne({ leadId, toStatus: status }).sort({ leadRevision: 1, _id: 1 }).session(session).lean();
  const lead = await LeadModel.findById(leadId).session(session).lean(); if (!event || !lead) return null;
  const assignment = await AssignmentModel.findOne({ entityType: 'LEAD', entityId: leadId, entityRevision: trusted({ $lte: event.leadRevision }) }).sort({ entityRevision: -1 }).session(session).lean();
  const employeeId = milestone === 'CREATED' ? lead.createdBy : assignment?.assignedTo ?? event.actorId;
  const [record] = await TargetEvidenceModel.create([{ leadId, milestone, sourceEventId: event._id, employeeId, branchId: lead.branchId, createdBy: lead.createdBy,
    assignedTo: assignment?.assignedTo ?? null, performedBy: event.actorId, occurredAt: milestone === 'CREATED' ? lead.createdAt : event.createdAt, valueAtConversion: event.valueAtConversion ?? null }], { session });
  if (!record) throw new Error('Target evidence insertion failed');
  await audit(session, context, 'TARGET_EVIDENCE_CAPTURED', actorId, 'target_evidence', record._id, { leadId: leadId.toHexString(), milestone }); return record.toObject();
}
