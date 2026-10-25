import { Schema, model, type InferSchemaType } from 'mongoose';
import { attendancePolicySchema } from '../attendance/attendance-policy.js';
const schema = new Schema({
  branchCode: { type: String, required: true, uppercase: true, match: /^[A-Z0-9_-]{2,32}$/, unique: true },
  branchName: { type: String, required: true, trim: true, maxlength: 100 },
  address: { type: String, required: true, trim: true, maxlength: 500 },
  stateId: { type: Schema.Types.ObjectId, ref: 'State', required: true },
  districtId: { type: Schema.Types.ObjectId, ref: 'District', required: true },
  blockId: { type: Schema.Types.ObjectId, ref: 'Block', default: null },
  contactNumber: { type: String, required: true, match: /^\+[1-9]\d{7,14}$/ },
  branchHeadId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  isActive: { type: Boolean, default: true, required: true },
  attendancePolicy: { type: attendancePolicySchema, default: () => ({}) },
  createdBy: { type: Schema.Types.ObjectId, required: true }, revision: { type: Number, default: 0, required: true },
}, { timestamps: true, strict: 'throw', collection: 'branches', versionKey: false });
schema.index({ stateId: 1, districtId: 1, isActive: 1 });
schema.index({ branchHeadId: 1 }, { unique: true, partialFilterExpression: { branchHeadId: { $type: 'objectId' } } });
export type Branch = InferSchemaType<typeof schema>;
export const BranchModel = model('Branch', schema);
