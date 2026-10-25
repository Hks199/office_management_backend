import { Schema, model } from 'mongoose';
export const LEAD_STATUSES = ['NEW', 'ASSIGNED', 'CONTACTED', 'INTERESTED', 'QUALIFIED', 'SITE_VISIT_SCHEDULED', 'SITE_VISITED', 'QUOTATION_SENT', 'NEGOTIATION', 'CONVERTED', 'NOT_INTERESTED', 'LOST', 'ON_HOLD'] as const;
export type LeadStatus = typeof LEAD_STATUSES[number];
export const REFERENCE_CATEGORIES = ['PAYMENT_MODE', 'PANEL_BRAND', 'PANEL_TECHNOLOGY', 'LEAD_SOURCE'] as const;
const options = { strict: 'throw' as const, timestamps: true as const, versionKey: false as const };
export const contactFields = {
  customerName: { type: String, required: true, maxlength: 150 }, mobileNumber: { type: String, required: true, match: /^\+[1-9]\d{7,14}$/ },
  alternateNumber: { type: String, default: '', maxlength: 16 }, stateId: { type: Schema.Types.ObjectId, required: true, ref: 'State' },
  districtId: { type: Schema.Types.ObjectId, required: true, ref: 'District' }, blockId: { type: Schema.Types.ObjectId, default: null, ref: 'Block' },
  tehsil: { type: String, default: '', maxlength: 100 }, siteAddress: { type: String, required: true, maxlength: 1000 }, remarks: { type: String, default: '', maxlength: 2000 },
};
const customerSchema = new Schema({ ...contactFields, branchId: { type: Schema.Types.ObjectId, required: true, ref: 'Branch' },
  dedupeKey: { type: String, required: true, unique: true, select: false }, importId: { type: Schema.Types.ObjectId, required: true },
  importRow: { type: Number, required: true }, createdBy: { type: Schema.Types.ObjectId, required: true },
  assignedTo: { type: Schema.Types.ObjectId, required: true, ref: 'User' }, assignedBy: { type: Schema.Types.ObjectId, required: true }, assignedAt: { type: Date, required: true },
  status: { type: String, enum: ['AVAILABLE', 'INTERESTED', 'NOT_INTERESTED', 'CONVERTED'], default: 'AVAILABLE', required: true },
  leadId: { type: Schema.Types.ObjectId, default: null, ref: 'Lead' }, revision: { type: Number, default: 0, required: true },
}, { ...options, collection: 'customers' });
customerSchema.index({ importId: 1, importRow: 1 }, { unique: true }); customerSchema.index({ assignedTo: 1, status: 1, _id: 1 });
customerSchema.index({ branchId: 1, createdAt: -1 });
export const CustomerModel = model('Customer', customerSchema);
const leadSchema = new Schema({ ...contactFields, leadCode: { type: String, required: true, unique: true },
  sourceCustomerId: { type: Schema.Types.ObjectId, ref: 'Customer', default: null }, branchId: { type: Schema.Types.ObjectId, required: true, ref: 'Branch' },
  requiredCapacityKw: { type: Schema.Types.Decimal128, required: true }, ratePerKw: { type: Schema.Types.Decimal128, required: true }, estimatedProjectValue: { type: Schema.Types.Decimal128, required: true },
  paymentMode: { type: String, required: true }, panelBrand: { type: String, required: true }, panelTechnology: { type: String, required: true }, leadSource: { type: String, required: true },
  status: { type: String, enum: LEAD_STATUSES, required: true, default: 'NEW' }, resumeStatus: { type: String, enum: LEAD_STATUSES, default: null },
  workflowVersion: { type: Number, required: true }, createdBy: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  assignedTo: { type: Schema.Types.ObjectId, default: null, ref: 'User' }, assignedBy: { type: Schema.Types.ObjectId, default: null }, assignedAt: { type: Date, default: null },
  telecallerId: { type: Schema.Types.ObjectId, default: null }, salesExecutiveId: { type: Schema.Types.ObjectId, default: null },
  routedBy: { type: Schema.Types.ObjectId, default: null }, routedAt: { type: Date, default: null },
  nextFollowUpAt: { type: Date, default: null }, lastContactedAt: { type: Date, default: null }, revision: { type: Number, default: 0, required: true },
}, { ...options, collection: 'leads' });
leadSchema.index({ sourceCustomerId: 1 }, { unique: true, partialFilterExpression: { sourceCustomerId: { $type: 'objectId' } } });
leadSchema.index({ assignedTo: 1, status: 1, nextFollowUpAt: 1, _id: 1 }); leadSchema.index({ branchId: 1, status: 1, createdAt: -1 });
leadSchema.index({ branchId: 1, assignedTo: 1, createdAt: -1 });
leadSchema.index({ createdBy: 1, createdAt: -1 }); leadSchema.index({ stateId: 1, districtId: 1, blockId: 1 });
export const LeadModel = model('Lead', leadSchema);
function immutable(schema: Schema): void {
  schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'], () => { throw new Error('History is append-only'); });
  schema.pre('bulkWrite', () => { throw new Error('History is append-only'); });
}
const assignmentSchema = new Schema({ entityId: { type: Schema.Types.ObjectId, required: true }, entityType: { type: String, enum: ['CUSTOMER', 'LEAD'], required: true },
  previousAssigneeId: { type: Schema.Types.ObjectId, default: null }, assignedTo: { type: Schema.Types.ObjectId, required: true },
  assignedBy: { type: Schema.Types.ObjectId, required: true }, reason: { type: String, required: true, maxlength: 500 }, entityRevision: { type: Number, required: true },
}, { strict: 'throw', timestamps: { createdAt: true, updatedAt: false }, versionKey: false, collection: 'lead_assignments' });
assignmentSchema.index({ entityType: 1, entityId: 1, entityRevision: 1 }, { unique: true }); immutable(assignmentSchema);
export const AssignmentModel = model('LeadAssignment', assignmentSchema);
const eventSchema = new Schema({ leadId: { type: Schema.Types.ObjectId, required: true }, fromStatus: { type: String, enum: LEAD_STATUSES, default: null },
  toStatus: { type: String, enum: LEAD_STATUSES, required: true }, actorId: { type: Schema.Types.ObjectId, required: true },
  workflowVersion: { type: Number, required: true }, leadRevision: { type: Number, required: true }, reason: { type: String, maxlength: 500, default: '' },
  valueAtConversion: { type: Schema.Types.Decimal128, default: null },
}, { strict: 'throw', timestamps: { createdAt: true, updatedAt: false }, versionKey: false, collection: 'lead_status_events' });
eventSchema.index({ leadId: 1, leadRevision: 1 }, { unique: true }); immutable(eventSchema);
export const LeadEventModel = model('LeadStatusEvent', eventSchema);
const proposalSchema = new Schema({ leadId: { type: Schema.Types.ObjectId, required: true }, proposedTo: { type: Schema.Types.ObjectId, required: true },
  proposedBy: { type: Schema.Types.ObjectId, required: true }, leadRevision: { type: Number, required: true }, reason: { type: String, required: true, maxlength: 500 },
  status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING', required: true },
  reviewedBy: { type: Schema.Types.ObjectId, default: null }, reviewedAt: { type: Date, default: null }, reviewReason: { type: String, default: '', maxlength: 500 },
  expiresAt: { type: Date, required: true },
}, { ...options, collection: 'lead_assignment_proposals' });
proposalSchema.index({ leadId: 1, status: 1 });
export const ProposalModel = model('LeadAssignmentProposal', proposalSchema);
const referenceSchema = new Schema({ category: { type: String, enum: REFERENCE_CATEGORIES, required: true }, code: { type: String, required: true, match: /^[A-Z0-9_-]{1,32}$/ },
  label: { type: String, required: true, maxlength: 100 }, isActive: { type: Boolean, default: true, required: true }, revision: { type: Number, default: 0, required: true },
  createdBy: { type: Schema.Types.ObjectId, required: true },
}, { ...options, collection: 'reference_values' }); referenceSchema.index({ category: 1, code: 1 }, { unique: true });
export const ReferenceModel = model('ReferenceValue', referenceSchema);
const workflowSchema = new Schema({ version: { type: Number, required: true, unique: true },
  transitions: { type: [new Schema({ from: { type: String, enum: LEAD_STATUSES, required: true }, to: { type: String, enum: LEAD_STATUSES, required: true } }, { _id: false })], required: true },
  createdBy: { type: Schema.Types.ObjectId, required: true },
}, { strict: 'throw', timestamps: { createdAt: true, updatedAt: false }, versionKey: false, collection: 'lead_workflows' }); immutable(workflowSchema);
export const WorkflowModel = model('LeadWorkflow', workflowSchema);
const configSchema = new Schema({ _id: { type: String, default: 'customers' }, duplicateScope: { type: String, enum: ['BRANCH', 'COMPANY'], default: 'BRANCH', required: true },
  revision: { type: Number, default: 0, required: true },
}, { ...options, collection: 'commercial_settings' });
export const CommercialSettingsModel = model('CommercialSettings', configSchema);
const idempotencySchema = new Schema({ actorId: { type: Schema.Types.ObjectId, required: true }, operation: { type: String, required: true },
  key: { type: String, required: true }, requestHash: { type: String, required: true }, entityId: { type: Schema.Types.ObjectId, required: true },
  expiresAt: { type: Date, required: true },
}, { strict: 'throw', collection: 'idempotency_keys' });
idempotencySchema.index({ actorId: 1, operation: 1, key: 1 }, { unique: true }); idempotencySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const IdempotencyModel = model('IdempotencyKey', idempotencySchema);
