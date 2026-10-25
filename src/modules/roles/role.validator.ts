import Joi from 'joi';
import { DATA_SCOPES } from '../../constants/permissions.js';
import { objectIdSchema } from '../../shared/utils/validation-schemas.js';

const grants = Joi.array().max(200).items(Joi.object({ permissionId: objectIdSchema.required(), scope: Joi.string().valid(...DATA_SCOPES).required() }));
export const idParams = Joi.object({ id: objectIdSchema.required() }).required();
export const roleQuery = Joi.object({
  page: Joi.number().integer().min(1).max(10000).default(1), limit: Joi.number().integer().min(1).max(100).default(20),
  sortBy: Joi.string().valid('name', 'createdAt').default('name'), sortOrder: Joi.string().valid('asc', 'desc').default('asc'),
  search: Joi.string().trim().min(2).max(100),
  isActive: Joi.boolean(),
});
export const policyQuery = Joi.object({ page: Joi.number().integer().min(1).max(10000).default(1),
  limit: Joi.number().integer().min(1).max(100).default(20), sortOrder: Joi.string().valid('asc', 'desc').default('desc'),
  isActive: Joi.boolean(), creatorRoleId: objectIdSchema, targetRoleId: objectIdSchema });
export const roleCreateSchema = Joi.object({ name: Joi.string().trim().min(2).max(100).required(),
  code: Joi.string().uppercase().pattern(/^[A-Z][A-Z0-9_]{1,31}$/).required(), description: Joi.string().max(500),
  permissions: grants.default([]), allowsNoBranch: Joi.boolean().default(false) }).required();
export const roleUpdateSchema = Joi.object({ revision: Joi.number().integer().min(0).required(),
  name: Joi.string().trim().min(2).max(100), description: Joi.string().max(500), permissions: grants, isActive: Joi.boolean(), allowsNoBranch: Joi.boolean(),
}).min(2).required();
export const archiveSchema = Joi.object({ revision: Joi.number().integer().min(0).required() }).required();
const policyFields = {
  creatorRoleId: objectIdSchema.required(), targetRoleId: objectIdSchema.required(),
  allowedManagerRoleIds: Joi.array().items(objectIdSchema.required()).min(1).max(20).unique().required(),
  branchRule: Joi.string().valid('SAME_BRANCH', 'EXPLICIT_SCOPE').default('SAME_BRANCH'),
  allowCrossBranchReporting: Joi.boolean().default(false), isActive: Joi.boolean().default(true),
};
export const policyCreateSchema = Joi.object(policyFields).required();
export const policyUpdateSchema = Joi.object({ ...policyFields, revision: Joi.number().integer().min(0).required() }).required();
