import { Schema, model } from 'mongoose';
import { DATA_SCOPES } from '../../constants/permissions.js';

const grantSchema = new Schema({
  permissionId: { type: Schema.Types.ObjectId, ref: 'Permission', required: true },
  scope: { type: String, enum: DATA_SCOPES, required: true },
}, { _id: false });
const schema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  code: { type: String, required: true, uppercase: true, match: /^[A-Z][A-Z0-9_]{1,31}$/, unique: true },
  description: { type: String, maxlength: 500 }, permissions: { type: [grantSchema], default: [] },
  isSystemRole: { type: Boolean, required: true, default: false },
  isActive: { type: Boolean, required: true, default: true },
  allowsNoBranch: { type: Boolean, required: true, default: false },
  createdBy: { type: Schema.Types.ObjectId, required: true },
  revision: { type: Number, required: true, default: 0, min: 0 },
}, { timestamps: true, strict: 'throw', collection: 'roles' });
schema.index({ isActive: 1, name: 1 });
export const RoleModel = model('Role', schema);
