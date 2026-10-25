import { Schema, model } from 'mongoose';
import { DATA_SCOPES, PERMISSION_CODES } from '../../constants/permissions.js';

const schema = new Schema({
  code: { type: String, enum: PERMISSION_CODES, required: true, unique: true },
  description: { type: String, required: true }, resource: { type: String, required: true },
  allowedScopes: { type: [String], enum: DATA_SCOPES, required: true },
  sensitive: { type: Boolean, required: true }, registryVersion: { type: Number, required: true },
}, { timestamps: true, strict: 'throw', collection: 'permissions' });
export const PermissionModel = model('Permission', schema);
