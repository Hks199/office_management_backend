import Joi from 'joi';
import { emailSchema } from '../auth/auth.validator.js';
import { objectIdSchema, dateSchema, phoneSchema } from '../../shared/utils/validation-schemas.js';
const revision = Joi.number().integer().min(0).required(); const reason = Joi.string().trim().min(3).max(500).required();
const name = Joi.string().trim().min(1).max(80);
const managers = { reportingManagerId: objectIdSchema, reportingManagerIds: Joi.array().items(objectIdSchema.required()).min(1).max(10).unique() };
const requireManagers = (schema: Joi.ObjectSchema) => schema.or('reportingManagerId', 'reportingManagerIds').custom((value: unknown, helpers) => {
  const input = value as { reportingManagerId?: string; reportingManagerIds?: string[] };
  return input.reportingManagerId && input.reportingManagerIds && input.reportingManagerId !== input.reportingManagerIds[0]
    ? helpers.error('any.invalid') : value;
});
export const employeeRoleOptionsQuery = Joi.object({
  page: Joi.number().integer().min(1).max(10000).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20),
  sortOrder: Joi.string().valid('asc', 'desc').default('asc'),
  search: Joi.string().trim().min(2).max(100),
});
export const employeeBranchOptionsQuery = employeeRoleOptionsQuery.keys({ roleId: objectIdSchema.required() });
export const employeeCreateSchema = requireManagers(Joi.object({ employeeCode: Joi.string().uppercase().pattern(/^[A-Z0-9-]{2,32}$/).required(),
  firstName: name.required(), lastName: name.required(), email: emailSchema, mobileNumber: phoneSchema.required(),
  roleId: objectIdSchema.required(), branchId: objectIdSchema.allow(null).required(), ...managers,
  dateOfJoining: dateSchema.required(), designation: Joi.string().trim().max(100), department: Joi.string().trim().max(100) })).required();
export const employeeUpdateSchema = Joi.object({ revision, firstName: name, lastName: name, email: emailSchema.optional(),
  mobileNumber: phoneSchema, dateOfJoining: dateSchema,
  designation: Joi.string().trim().max(100), department: Joi.string().trim().max(100) }).min(2).required();
export const employeeManagerSchema = requireManagers(Joi.object({ revision, reason, ...managers })).required();
export const employeeTransferSchema = requireManagers(Joi.object({ revision, reason, branchId: objectIdSchema.allow(null).required(), ...managers })).required();
export const employeeRoleSchema = Joi.object({ revision, reason, roleId: objectIdSchema.required() }).required();
export const employeeStatusSchema = Joi.object({ revision, reason, isActive: Joi.boolean().required(),
  employmentStatus: Joi.string().valid('ACTIVE', 'ON_LEAVE', 'EXITED').required() }).custom((value: unknown, helpers) => {
    const input = value as { isActive: boolean; employmentStatus: string };
    return input.isActive && input.employmentStatus === 'EXITED' ? helpers.error('any.invalid') : value;
  }).required();
export const employeeQuerySchema = Joi.object({ page: Joi.number().integer().min(1).max(10000).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20), sortBy: Joi.string().valid('employeeCode', 'firstName', 'createdAt', 'dateOfJoining').default('employeeCode'),
  sortOrder: Joi.string().valid('asc', 'desc').default('asc'), search: Joi.string().trim().min(2).max(100),
  branchId: objectIdSchema, roleId: objectIdSchema, managerId: objectIdSchema, isActive: Joi.boolean(), department: Joi.string().max(100),
  employmentStatus: Joi.string().valid('ACTIVE', 'ON_LEAVE', 'EXITED'), startDate: dateSchema, endDate: dateSchema,
}).custom((value: unknown, helpers) => {
  const input = value as { startDate?: string; endDate?: string };
  return input.startDate && input.endDate && new Date(input.startDate) >= new Date(input.endDate) ? helpers.error('any.invalid') : value;
});
export const hierarchyQuerySchema = employeeQuerySchema.keys({ rootId: objectIdSchema, depth: Joi.number().integer().min(1).max(20).default(20) }).oxor('rootId', 'managerId');
