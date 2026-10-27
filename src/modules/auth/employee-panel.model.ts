import { Schema, model } from 'mongoose';

const schema = new Schema({
  managerId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  managerFamilyId: { type: String, required: true }, managerAuthVersion: { type: Number, required: true },
  employeeId: { type: Schema.Types.ObjectId, required: true, ref: 'User' },
  employeeAuthVersion: { type: Number, required: true },
  employeeSessionId: { type: Schema.Types.ObjectId, required: true },
  tokenHash: { type: String, required: true, select: false, unique: true },
  expiresAt: { type: Date, required: true }, revokedAt: { type: Date, default: null },
}, { timestamps: true, strict: 'throw', collection: 'employee_panels' });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
schema.index({ managerId: 1, managerFamilyId: 1, revokedAt: 1 });
export const EmployeePanelModel = model('EmployeePanel', schema);
