import { Schema, model } from 'mongoose';

const schema = new Schema({
  creatorRoleId: { type: Schema.Types.ObjectId, ref: 'Role', required: true },
  targetRoleId: { type: Schema.Types.ObjectId, ref: 'Role', required: true },
  allowedManagerRoleIds: { type: [Schema.Types.ObjectId], ref: 'Role', required: true },
  branchRule: { type: String, enum: ['SAME_BRANCH', 'EXPLICIT_SCOPE'], default: 'SAME_BRANCH', required: true },
  allowCrossBranchReporting: { type: Boolean, default: false, required: true },
  isActive: { type: Boolean, default: true, required: true },
  createdBy: { type: Schema.Types.ObjectId, required: true },
  revision: { type: Number, default: 0, required: true },
  creatorRoleRevision: { type: Number, default: 0, required: true },
  targetRoleRevision: { type: Number, default: 0, required: true },
}, { timestamps: true, strict: 'throw', collection: 'role_creation_policies' });
schema.index({ creatorRoleId: 1, targetRoleId: 1 }, { unique: true });
export const RolePolicyModel = model('RolePolicy', schema);
