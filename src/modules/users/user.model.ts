import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

const schema = new Schema({
  employeeCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 32, unique: true },
  firstName: { type: String, required: true, trim: true, maxlength: 80 },
  lastName: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, trim: true, lowercase: true, maxlength: 254, unique: true },
  mobileNumber: { type: String, required: true, match: /^\+[1-9]\d{7,14}$/, unique: true },
  passwordHash: { type: String, select: false },
  roleId: { type: Schema.Types.ObjectId, ref: 'Role', required: true },
  branchId: { type: Schema.Types.ObjectId, ref: 'Branch', default: null },
  reportingManagerId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  reportingManagerIds: { type: [{ type: Schema.Types.ObjectId, ref: 'User' }], default: [], validate: {
    validator: (ids: unknown[]) => ids.length <= 10, message: 'At most ten reporting managers are allowed',
  } },
  designation: { type: String, maxlength: 100 }, department: { type: String, maxlength: 100 },
  dateOfJoining: { type: Date, required: true },
  employmentStatus: { type: String, enum: ['ACTIVE', 'ON_LEAVE', 'EXITED'], default: 'ACTIVE', required: true },
  isActive: { type: Boolean, default: true, required: true },
  createdBy: { type: Schema.Types.ObjectId, required: true },
  lastLoginAt: Date, passwordChangedAt: Date,
  authVersion: { type: Number, default: 0, min: 0, required: true },
  authFence: { type: Number, default: 0, required: true, select: false },
  revision: { type: Number, default: 0, min: 0, required: true },
  bootstrapKey: { type: String, select: false },
}, { timestamps: true, strict: 'throw', collection: 'users' });
// Legacy single-manager writes replace the complete manager selection.
schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate'], function () {
  const update = this.getUpdate();
  if (!update || Array.isArray(update)) return;
  const changes = update as { $set?: { reportingManagerId?: Types.ObjectId | null; reportingManagerIds?: Types.ObjectId[] } };
  if (changes.$set && 'reportingManagerId' in changes.$set && !('reportingManagerIds' in changes.$set)) {
    changes.$set.reportingManagerIds = changes.$set.reportingManagerId ? [changes.$set.reportingManagerId] : [];
  }
});
schema.pre('validate', function () {
  if (this.isModified('reportingManagerId') && !this.isModified('reportingManagerIds')) {
    this.reportingManagerIds = this.reportingManagerId ? [this.reportingManagerId] : [];
  }
});
schema.index({ reportingManagerId: 1, isActive: 1 });
schema.index({ reportingManagerIds: 1, isActive: 1 });
schema.index({ branchId: 1, roleId: 1, isActive: 1 });
schema.index({ bootstrapKey: 1 }, { unique: true, sparse: true });
export type User = InferSchemaType<typeof schema>;
export const UserModel = model('User', schema);
