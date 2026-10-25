import Joi from 'joi';
import { objectIdSchema } from '../../shared/utils/validation-schemas.js';
export const CSV_FIELDS = ['customerName', 'mobileNumber', 'alternateNumber', 'state', 'district', 'block', 'siteAddress', 'remarks'] as const;
export const defaultColumnMapping: Record<string, string> = { customerName: 'Contact Name', mobileNumber: 'Mobile Number', alternateNumber: 'Alternate Number',
  state: 'State', district: 'District', block: 'Block/Tehsil', siteAddress: 'Site Address', remarks: 'Remarks' };
export const csvUploadSchema = Joi.object({ filename: Joi.string().pattern(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}\.csv$/i).required(),
  size: Joi.number().integer().min(1).max(20971520).required(), checksumSHA256: Joi.string().pattern(/^[A-Za-z0-9+/]{43}=$/).required() }).required();
export const importCreateSchema = Joi.object({ fileId: objectIdSchema.required(), branchId: objectIdSchema.required(),
  columnMapping: Joi.object(Object.fromEntries(CSV_FIELDS.map((field) => [field, Joi.string().trim().min(1).max(100)])))
    .fork(['customerName', 'mobileNumber', 'state', 'district', 'siteAddress'], (field) => field.required()).custom((value: Record<string, string>, helpers) => new Set(Object.values(value)).size === Object.values(value).length ? value : helpers.error('any.invalid')).default(defaultColumnMapping),
}).required();
export const importConfirmSchema = Joi.object({ revision: Joi.number().integer().min(0).required(), assignedTo: objectIdSchema.required() }).required();
export const importAssigneeQuerySchema = Joi.object({ page: Joi.number().integer().min(1).max(10000).default(1), limit: Joi.number().integer().min(1).max(100).default(20),
  search: Joi.string().trim().min(2).max(100) });
export const importQuerySchema = Joi.object({ page: Joi.number().integer().min(1).max(10000).default(1), limit: Joi.number().integer().min(1).max(100).default(20),
  sortOrder: Joi.string().valid('asc', 'desc').default('desc'), branchId: objectIdSchema,
  status: Joi.string().valid('QUEUED_VALIDATION', 'VALIDATING', 'PREVIEW_READY', 'QUEUED_COMMIT', 'PROCESSING', 'COMPLETED', 'FAILED') });
export const importRowQuerySchema = Joi.object({ page: Joi.number().integer().min(1).max(10000).default(1), limit: Joi.number().integer().min(1).max(100).default(20),
  status: Joi.string().valid('VALID', 'REJECTED', 'DUPLICATE', 'IMPORTED') });
