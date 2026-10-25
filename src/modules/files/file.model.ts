import { Schema, model } from 'mongoose';
const schema = new Schema({
  filename: { type: String, maxlength: 255 },
  ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  purpose: { type: String, enum: ['ATTENDANCE_CHECK_IN', 'ATTENDANCE_CHECK_OUT', 'CUSTOMER_IMPORT', 'LEAD_EXPORT', 'SITE_VISIT', 'DASHBOARD_EXPORT'], required: true },
  objectKey: { type: String, required: true, unique: true, select: false },
  bucket: { type: String, required: true, select: false },
  contentType: { type: String, enum: ['image/jpeg', 'image/png', 'image/webp', 'text/csv'], required: true },
  size: { type: Number, min: 1, max: 20971520, required: true },
  checksumSHA256: { type: String, required: true, select: false },
  versionId: { type: String, select: false },
  status: { type: String, enum: ['PENDING', 'READY', 'ATTACHED', 'DELETING', 'DELETED'], default: 'PENDING', required: true },
  expiresAt: { type: Date, required: true }, confirmedAt: Date,
  attendanceId: { type: Schema.Types.ObjectId, ref: 'Attendance', default: null },
  visitId: { type: Schema.Types.ObjectId, ref: 'ReportActivity', default: null },
  importId: { type: Schema.Types.ObjectId, default: null }, exportId: { type: Schema.Types.ObjectId, default: null },
}, { strict: 'throw', timestamps: true, versionKey: false, collection: 'files' });
schema.index({ status: 1, expiresAt: 1 }); schema.index({ ownerId: 1, createdAt: -1 });
export const FileModel = model('File', schema);
export interface UploadInput { purpose: 'ATTENDANCE_CHECK_IN' | 'ATTENDANCE_CHECK_OUT'; filename: string; contentType: 'image/jpeg' | 'image/png' | 'image/webp'; size: number; checksumSHA256: string }
export interface StoredPhoto { bucket: string; objectKey: string; contentType: string; size: number; checksumSHA256: string }
