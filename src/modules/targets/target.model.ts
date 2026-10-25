import { Schema, model } from 'mongoose';
import { TARGET_TYPES, PERIOD_TYPES } from './target.types.js';
const definition = {
  employeeId: { type: Schema.Types.ObjectId, required: true, ref: 'User' }, branchId: { type: Schema.Types.ObjectId, required: true, ref: 'Branch' },
  targetType: { type: String, enum: TARGET_TYPES, required: true }, targetValue: { type: Schema.Types.Decimal128, required: true },
  periodType: { type: String, enum: PERIOD_TYPES, required: true }, startDate: { type: Date, required: true }, endDate: { type: Date, required: true },
  status: { type: String, enum: ['ACTIVE', 'CANCELLED'], default: 'ACTIVE', required: true }, assignedBy: { type: Schema.Types.ObjectId, required: true },
};
const schema = new Schema({ ...definition, revision: { type: Number, default: 0, required: true } }, { strict: 'throw', timestamps: true, versionKey: false, collection: 'targets' });
schema.index({ employeeId: 1, branchId: 1, targetType: 1, periodType: 1, startDate: 1, endDate: 1 }, { unique: true, partialFilterExpression: { status: 'ACTIVE' } });
schema.index({ employeeId: 1, status: 1, startDate: 1 }); schema.index({ branchId: 1, status: 1, startDate: 1 });
export const TargetModel = model('Target', schema);
function appendOnly(schema: Schema): void {
  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'], () => { throw new Error('Target history is append-only'); });
  schema.pre('bulkWrite', () => { throw new Error('Target history is append-only'); });
  schema.pre('save', function () { if (!this.isNew) throw new Error('Target history is append-only'); });
  schema.pre('deleteOne', { document: true, query: false }, () => { throw new Error('Target history is append-only'); });
}
const revisions = new Schema({ ...definition, targetId: { type: Schema.Types.ObjectId, required: true }, revision: { type: Number, required: true },
  changedBy: { type: Schema.Types.ObjectId, required: true }, reason: { type: String, required: true, maxlength: 500 },
}, { strict: 'throw', timestamps: { createdAt: true, updatedAt: false }, versionKey: false, collection: 'target_revisions' });
revisions.index({ targetId: 1, revision: 1 }, { unique: true }); appendOnly(revisions);
export const TargetRevisionModel = model('TargetRevision', revisions);
const evidence = new Schema({
  leadId: { type: Schema.Types.ObjectId, required: true }, sourceEventId: { type: Schema.Types.ObjectId, required: true },
  milestone: { type: String, enum: ['CREATED', 'QUALIFIED', 'CONVERTED'], required: true }, employeeId: { type: Schema.Types.ObjectId, required: true },
  branchId: { type: Schema.Types.ObjectId, required: true }, createdBy: { type: Schema.Types.ObjectId, required: true }, assignedTo: { type: Schema.Types.ObjectId, default: null },
  performedBy: { type: Schema.Types.ObjectId, required: true }, occurredAt: { type: Date, required: true }, valueAtConversion: { type: Schema.Types.Decimal128, default: null },
  reviewStatus: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING', required: true }, revision: { type: Number, default: 0, required: true },
  reviewedBy: { type: Schema.Types.ObjectId, default: null }, reviewedAt: { type: Date, default: null }, remarks: { type: String, maxlength: 500, default: '' },
}, { strict: 'throw', timestamps: true, versionKey: false, collection: 'target_evidence' });
evidence.index({ leadId: 1, milestone: 1 }, { unique: true }); evidence.index({ employeeId: 1, branchId: 1, milestone: 1, reviewStatus: 1, occurredAt: 1 });
evidence.index({ employeeId: 1, reviewStatus: 1, occurredAt: 1 });
export const TargetEvidenceModel = model('TargetEvidence', evidence);
const reviews = new Schema({ evidenceId: { type: Schema.Types.ObjectId, required: true }, actorId: { type: Schema.Types.ObjectId, required: true },
  revision: { type: Number, required: true }, before: { type: String, required: true }, after: { type: String, required: true }, remarks: { type: String, required: true, maxlength: 500 },
}, { strict: 'throw', timestamps: { createdAt: true, updatedAt: false }, versionKey: false, collection: 'target_evidence_reviews' });
reviews.index({ evidenceId: 1, revision: 1 }, { unique: true }); appendOnly(reviews);
export const TargetEvidenceReviewModel = model('TargetEvidenceReview', reviews);
