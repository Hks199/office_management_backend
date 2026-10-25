import { Schema, model } from 'mongoose';
const principalFields = { userId: { type: Schema.Types.ObjectId, required: true }, roleId: { type: Schema.Types.ObjectId, required: true },
  sessionId: { type: Schema.Types.ObjectId, required: true }, branchId: { type: Schema.Types.ObjectId, default: null }, authVersion: { type: Number, required: true } };
const schema = new Schema({ createdBy: { type: Schema.Types.ObjectId, required: true }, branchId: { type: Schema.Types.ObjectId, required: true },
  principal: { type: new Schema(principalFields, { _id: false }), required: true, select: false },
  fileId: { type: Schema.Types.ObjectId, required: true, unique: true }, assignedTo: { type: Schema.Types.ObjectId, default: null },
  columnMapping: { type: Map, of: String, required: true }, duplicateScope: { type: String, enum: ['BRANCH', 'COMPANY'], required: true },
  status: { type: String, enum: ['QUEUED_VALIDATION', 'VALIDATING', 'PREVIEW_READY', 'QUEUED_COMMIT', 'PROCESSING', 'COMPLETED', 'FAILED'], default: 'QUEUED_VALIDATION', required: true },
  totalRows: { type: Number, default: 0, required: true }, acceptedRows: { type: Number, default: 0, required: true }, rejectedRows: { type: Number, default: 0, required: true },
  duplicateRows: { type: Number, default: 0, required: true }, importedRows: { type: Number, default: 0, required: true },
  revision: { type: Number, default: 0, required: true }, confirmedAt: { type: Date, default: null }, finishedAt: { type: Date, default: null },
  leaseId: { type: String, select: false }, leaseUntil: { type: Date, select: false }, attempts: { type: Number, default: 0, required: true },
  errorCode: { type: String, default: '', maxlength: 100 }, requestId: { type: String, required: true }, expiresAt: { type: Date, required: true },
}, { timestamps: true, strict: 'throw', versionKey: false, collection: 'csv_imports' });
schema.index({ status: 1, leaseUntil: 1 }); schema.index({ createdBy: 1, createdAt: -1 }); schema.index({ branchId: 1, createdAt: -1 });
export const ImportModel = model('CsvImport', schema);
const rowSchema = new Schema({ importId: { type: Schema.Types.ObjectId, required: true }, rowNumber: { type: Number, required: true },
  status: { type: String, enum: ['VALID', 'REJECTED', 'DUPLICATE', 'IMPORTED'], required: true },
  normalizedData: { type: new Schema({ customerName: String, mobileNumber: String, alternateNumber: String, stateId: String, districtId: String,
    blockId: { type: String, default: null }, tehsil: String, siteAddress: String, remarks: String }, { _id: false, strict: 'throw' }), default: null },
  rowErrors: { type: [String], default: [] }, expiresAt: { type: Date, required: true },
  inputLocation: { type: new Schema({ state: String, district: String, block: String }, { _id: false, strict: 'throw' }) },
  rowIssues: { type: [new Schema({ field: { type: String, maxlength: 100 }, code: { type: String, maxlength: 100 } }, { _id: false, strict: 'throw' })], default: [] },
}, { strict: 'throw', collection: 'csv_import_rows', versionKey: false });
rowSchema.index({ importId: 1, rowNumber: 1 }, { unique: true }); rowSchema.index({ importId: 1, status: 1, rowNumber: 1 });
rowSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const ImportRowModel = model('CsvImportRow', rowSchema);
const exportSchema = new Schema({ createdBy: { type: Schema.Types.ObjectId, required: true }, principal: { type: new Schema(principalFields, { _id: false }), required: true, select: false },
  query: { type: new Schema({ branchId: String, assignedTo: String, createdBy: String, stateId: String, districtId: String, blockId: String,
    status: String, search: String, startDate: String, endDate: String, followUpFrom: String, followUpTo: String, leadSource: String, assignmentState: String,
    page: Number, limit: Number, sortOrder: String }, { _id: false, strict: 'throw' }), required: true, select: false },
  status: { type: String, enum: ['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'], default: 'QUEUED', required: true },
  fileId: { type: Schema.Types.ObjectId, default: null }, leadIds: { type: [Schema.Types.ObjectId], default: [], select: false },
  leaseId: { type: String, select: false }, leaseUntil: { type: Date, select: false }, attempts: { type: Number, default: 0, required: true },
  errorCode: { type: String, default: '' }, requestId: { type: String, required: true }, expiresAt: { type: Date, required: true },
}, { timestamps: true, strict: 'throw', versionKey: false, collection: 'lead_exports' });
exportSchema.index({ status: 1, leaseUntil: 1 }); exportSchema.index({ createdBy: 1, createdAt: -1 });
export const LeadExportModel = model('LeadExport', exportSchema);
