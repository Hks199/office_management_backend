import { Schema, model } from 'mongoose';
import { attendancePolicySchema } from './attendance-policy.js';
const location = new Schema({ latitude: { type: Number, min: -90, max: 90, required: true },
  longitude: { type: Number, min: -180, max: 180, required: true }, accuracyMeters: { type: Number, min: 0, max: 100000 } }, { _id: false });
const schema = new Schema({
  employeeId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, branchId: { type: Schema.Types.ObjectId, ref: 'Branch', default: null },
  attendanceDate: { type: String, match: /^\d{4}-\d{2}-\d{2}$/, required: true },
  checkInAt: { type: Date, required: true }, checkOutAt: { type: Date, default: null },
  effectiveCheckInAt: { type: Date, required: true }, effectiveCheckOutAt: { type: Date, default: null },
  checkInCapturedAt: { type: Date, required: true }, checkOutCapturedAt: { type: Date, default: null },
  checkInPhotoFileId: { type: Schema.Types.ObjectId, ref: 'File', required: true }, checkOutPhotoFileId: { type: Schema.Types.ObjectId, ref: 'File', default: null },
  checkInLocation: { type: location, required: true }, checkOutLocation: { type: location, default: null },
  policySnapshot: { type: attendancePolicySchema, required: true },
  evidenceFlags: { type: [String], default: [] }, lateArrival: { type: Boolean, required: true }, earlyExit: { type: Boolean, default: false },
  status: { type: String, enum: ['OPEN', 'COMPLETED'], default: 'OPEN', required: true },
  reviewStatus: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED'], default: 'PENDING', required: true },
  reviewedBy: { type: Schema.Types.ObjectId, default: null }, reviewedAt: { type: Date, default: null }, remarks: { type: String, maxlength: 500, default: '' },
  corrected: { type: Boolean, default: false }, revision: { type: Number, default: 0, required: true },
}, { strict: 'throw', timestamps: true, versionKey: false, collection: 'attendance' });
schema.index({ employeeId: 1, attendanceDate: 1 }, { unique: true });
schema.index({ employeeId: 1, status: 1 }, { unique: true, partialFilterExpression: { status: 'OPEN' } });
schema.index({ branchId: 1, attendanceDate: -1, reviewStatus: 1 }); schema.index({ attendanceDate: -1, _id: 1 });
schema.index({ employeeId: 1, effectiveCheckInAt: 1 }); schema.index({ branchId: 1, effectiveCheckInAt: 1 });
export const AttendanceModel = model('Attendance', schema);
