import { Schema, model } from 'mongoose';
const schema = new Schema({
  _id: { type: String, enum: ['office'], required: true },
  startMinute: { type: Number, required: true, min: 0, max: 1439 },
  endMinute: { type: Number, required: true, min: 1, max: 1439 },
  graceMinutes: { type: Number, required: true, min: 0, max: 120 },
  workingWeekdays: { type: [Number], required: true }, holidays: { type: [String], required: true },
  revision: { type: Number, default: 0, required: true },
  changedBy: { type: Schema.Types.ObjectId, required: true },
}, { strict: 'throw', versionKey: false, timestamps: true, collection: 'attendance_office_settings' });
export const OfficeSettingsModel = model('OfficeAttendanceSettings', schema);
