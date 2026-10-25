import { Schema, model } from 'mongoose';
export const CALL_OUTCOMES = ['CONNECTED', 'NOT_ANSWERED', 'BUSY', 'SWITCHED_OFF', 'WRONG_NUMBER', 'CALLBACK_REQUESTED', 'INTERESTED', 'NOT_INTERESTED'] as const;
export const INTEREST = ['UNKNOWN', 'INTERESTED', 'NOT_INTERESTED', 'UNDECIDED'] as const;
export const VISIT_OUTCOMES = ['COMPLETED', 'FOLLOW_UP_REQUIRED', 'CUSTOMER_UNAVAILABLE', 'NOT_INTERESTED'] as const;
const location = new Schema({ latitude: { type: Number, required: true, min: -90, max: 90 }, longitude: { type: Number, required: true, min: -180, max: 180 }, accuracyMeters: { type: Number, min: 0, max: 100000 } }, { _id: false });
// Only service-owned, validated submissions can populate these fields. Owners and snapshots never change.
const schema = new Schema({
  kind: { type: String, enum: ['CALL', 'VISIT'], required: true }, employeeId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  branchId: { type: Schema.Types.ObjectId, required: true, ref: 'Branch' }, businessDate: { type: String, required: true },
  idempotencyKey: { type: String, required: true, select: false }, requestHash: { type: String, required: true, select: false },
  customerId: { type: Schema.Types.ObjectId, default: null }, leadId: { type: Schema.Types.ObjectId, default: null },
  customerName: { type: String, required: true }, customerMobile: { type: String, required: true }, siteAddress: { type: String, required: true },
  callStartedAt: Date, callEndedAt: Date, callDurationSeconds: Number, callOutcome: { type: String, enum: CALL_OUTCOMES },
  customerInterest: { type: String, enum: INTEREST, default: 'UNKNOWN' }, followUpAt: { type: Date, default: null }, remarks: { type: String, maxlength: 2000, default: '' },
  convertedToLead: { type: Boolean, default: false },
  salesExecutiveId: { type: Schema.Types.ObjectId, default: null }, visitDate: String, visitStartedAt: Date, visitCompletedAt: { type: Date, default: null },
  clientCapturedAt: Date, completedCapturedAt: Date, startLocation: location, location,
  point: { type: new Schema({ type: { type: String, enum: ['Point'], required: true }, coordinates: { type: [Number], required: true } }, { _id: false }) },
  photoFileIds: { type: [Schema.Types.ObjectId], default: [] }, evidenceFlags: { type: [String], default: [] },
  requiredCapacityKw: { type: Schema.Types.Decimal128, default: null }, ratePerKw: { type: Schema.Types.Decimal128, default: null }, estimatedProjectValue: { type: Schema.Types.Decimal128, default: null },
  installationReadiness: { type: String, enum: ['UNKNOWN', 'READY', 'NOT_READY'], default: 'UNKNOWN' }, discussionNotes: { type: String, maxlength: 4000, default: '' },
  nextFollowUpAt: { type: Date, default: null }, visitOutcome: { type: String, enum: VISIT_OUTCOMES },
  status: { type: String, enum: ['OPEN', 'SUBMITTED', 'EXPIRED'], required: true },
  reviewStatus: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING', required: true },
  reviewedBy: { type: Schema.Types.ObjectId, default: null }, reviewedAt: { type: Date, default: null }, reviewRemarks: { type: String, default: '', maxlength: 500 },
  revision: { type: Number, default: 0, required: true },
}, { strict: 'throw', timestamps: true, versionKey: false, collection: 'report_activities' });
schema.index({ employeeId: 1, kind: 1, idempotencyKey: 1 }, { unique: true });
schema.index({ employeeId: 1, leadId: 1, kind: 1, status: 1 }, { unique: true, partialFilterExpression: { kind: 'VISIT', status: 'OPEN' } });
schema.index({ employeeId: 1, callStartedAt: 1, callEndedAt: 1 }, { unique: true, partialFilterExpression: { kind: 'CALL' } });
schema.index({ kind: 1, employeeId: 1, businessDate: -1, _id: -1 }); schema.index({ kind: 1, branchId: 1, businessDate: -1 });
schema.index({ leadId: 1, createdAt: -1 }); schema.index({ customerId: 1, callStartedAt: -1 }); schema.index({ point: '2dsphere' });
// Dashboard completion windows include submitted/pending/rejected rows, so reviewStatus
// cannot precede the range key. Preserve target-specific approved indexes separately.
schema.index({ employeeId: 1, kind: 1, callEndedAt: 1 });
schema.index({ employeeId: 1, kind: 1, visitCompletedAt: 1 });
schema.index({ branchId: 1, kind: 1, callEndedAt: 1 });
schema.index({ branchId: 1, kind: 1, visitCompletedAt: 1 });
export const ReportModel = model('ReportActivity', schema);
const history = new Schema({ reportId: { type: Schema.Types.ObjectId, required: true }, actorId: { type: Schema.Types.ObjectId, required: true },
  action: { type: String, enum: ['CREATED', 'SUBMITTED', 'REVIEWED', 'EXPIRED'], required: true }, revision: { type: Number, required: true },
  before: { type: String, default: '' }, after: { type: String, required: true }, remarks: { type: String, maxlength: 500, default: '' },
}, { strict: 'throw', timestamps: { createdAt: true, updatedAt: false }, versionKey: false, collection: 'report_history' });
history.index({ reportId: 1, revision: 1 }, { unique: true });
history.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'], () => { throw new Error('Report history is append-only'); });
history.pre('bulkWrite', () => { throw new Error('Report history is append-only'); });
history.pre('save', function () { if (!this.isNew) throw new Error('Report history is append-only'); });
history.pre('deleteOne', { document: true, query: false }, () => { throw new Error('Report history is append-only'); });
export const ReportHistoryModel = model('ReportHistory', history);
