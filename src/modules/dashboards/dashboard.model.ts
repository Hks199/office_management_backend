import { Schema, model } from 'mongoose';
import { DASHBOARD_KINDS } from './dashboard.types.js';
const calendar = new Schema({ branchId: { type: Schema.Types.ObjectId, required: true, unique: true },
  workingWeekdays: { type: [Number], required: true }, holidays: { type: [String], required: true }, revision: { type: Number, required: true, default: 0 },
  changedBy: { type: Schema.Types.ObjectId, required: true },
}, { strict: 'throw', timestamps: true, versionKey: false, collection: 'attendance_calendars' });
export const AttendanceCalendarModel = model('AttendanceCalendar', calendar);
const principal = new Schema({ userId: { type: Schema.Types.ObjectId, required: true }, roleId: { type: Schema.Types.ObjectId, required: true },
  sessionId: { type: Schema.Types.ObjectId, required: true }, branchId: { type: Schema.Types.ObjectId, default: null }, authVersion: { type: Number, required: true } }, { _id: false });
const query = new Schema({ startDate: String, endDate: String, branchId: String, employeeId: String, managerId: String, roleId: String, stateId: String, districtId: String, blockId: String,
  search: String, leadStatus: { type: [String], default: undefined }, leadSource: String, targetType: String, compare: Boolean, page: Number, limit: Number, sortBy: String, sortOrder: String }, { _id: false, strict: 'throw' });
const exportSchema = new Schema({ createdBy: { type: Schema.Types.ObjectId, required: true }, kind: { type: String, enum: DASHBOARD_KINDS, required: true },
  principal: { type: principal, required: true, select: false }, query: { type: query, required: true, select: false },
  asOf: { type: Date, default: null }, fingerprint: { type: String, default: '', select: false }, fileId: { type: Schema.Types.ObjectId, default: null },
  status: { type: String, enum: ['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'], required: true, default: 'QUEUED' },
  leaseId: { type: String, select: false }, leaseUntil: { type: Date, select: false }, attempts: { type: Number, required: true, default: 0 },
  errorCode: { type: String, default: '' }, requestId: { type: String, required: true }, expiresAt: { type: Date, required: true },
}, { strict: 'throw', timestamps: true, versionKey: false, collection: 'dashboard_exports' });
exportSchema.index({ status: 1, leaseUntil: 1 }); exportSchema.index({ createdBy: 1, createdAt: -1 });
export const DashboardExportModel = model('DashboardExport', exportSchema);
