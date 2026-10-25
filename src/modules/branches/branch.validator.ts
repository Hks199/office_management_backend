import Joi from 'joi';
import { attendancePolicyValidation } from '../attendance/attendance-policy.js';
import { objectIdSchema, phoneSchema } from '../../shared/utils/validation-schemas.js';
const profile = { branchName: Joi.string().trim().min(2).max(100), address: Joi.string().trim().min(5).max(500),
  contactNumber: phoneSchema };
export const branchCreateSchema = Joi.object({ branchCode: Joi.string().uppercase().pattern(/^[A-Z0-9_-]{2,32}$/).required(),
  branchName: profile.branchName.required(), address: profile.address.required(), contactNumber: profile.contactNumber.required(),
  stateId: objectIdSchema.required(), districtId: objectIdSchema.required(), blockId: objectIdSchema.allow(null), attendancePolicy: attendancePolicyValidation }).required();
export const branchUpdateSchema = Joi.object({ revision: Joi.number().integer().min(0).required(), ...profile,
  stateId: objectIdSchema, districtId: objectIdSchema, blockId: objectIdSchema.allow(null), isActive: Joi.boolean(), attendancePolicy: attendancePolicyValidation }).min(2).required();
export const branchHeadSchema = Joi.object({ revision: Joi.number().integer().min(0).required(), branchHeadId: objectIdSchema.allow(null).required(),
  reason: Joi.string().trim().min(3).max(500).required() }).required();
export const branchQuerySchema = Joi.object({ page: Joi.number().integer().min(1).max(10000).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20), sortBy: Joi.string().valid('branchName', 'branchCode', 'createdAt').default('branchName'),
  sortOrder: Joi.string().valid('asc', 'desc').default('asc'), search: Joi.string().trim().min(2).max(100), isActive: Joi.boolean(),
  stateId: objectIdSchema, districtId: objectIdSchema, blockId: objectIdSchema });
