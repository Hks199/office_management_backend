import Joi from 'joi';
import { objectIdSchema } from '../../shared/utils/validation-schemas.js';
import { TARGET_TYPES, PERIOD_TYPES } from './target.types.js';
export const businessDay = Joi.string().pattern(/^20\d{2}-\d{2}-\d{2}$/).custom((value: string, helpers) => {
  const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : helpers.error('date.format');
});
const value = Joi.string().pattern(/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/);
const revision = Joi.number().integer().min(0).required();
export const pagination = { page: Joi.number().integer().min(1).max(10000).default(1), limit: Joi.number().integer().min(1).max(100).default(20), sortOrder: Joi.string().valid('asc', 'desc').default('desc') };
export const targetCreateSchema = Joi.object({ employeeId: objectIdSchema.required(), targetType: Joi.string().valid(...TARGET_TYPES).required(), targetValue: value.required(),
  periodType: Joi.string().valid(...PERIOD_TYPES).required(), startDate: businessDay.required(), endDate: businessDay.required() }).required();
export const targetUpdateSchema = Joi.object({ revision, targetValue: value, startDate: businessDay, endDate: businessDay, status: Joi.string().valid('ACTIVE', 'CANCELLED'), reason: Joi.string().trim().min(3).max(500).required() }).or('targetValue', 'startDate', 'endDate', 'status').required();
export const targetQuerySchema = Joi.object({ employeeId: objectIdSchema, branchId: objectIdSchema, targetType: Joi.string().valid(...TARGET_TYPES), periodType: Joi.string().valid(...PERIOD_TYPES),
  status: Joi.string().valid('ACTIVE', 'CANCELLED').default('ACTIVE'), from: businessDay, to: businessDay, ...pagination }).custom((input: { from?: string; to?: string }, helpers) => input.from && input.to && input.from >= input.to ? helpers.error('date.order') : input);
export const historyQuerySchema = Joi.object(pagination);
export const evidenceQuerySchema = Joi.object({ employeeId: objectIdSchema, branchId: objectIdSchema, leadId: objectIdSchema, milestone: Joi.string().valid('CREATED', 'QUALIFIED', 'CONVERTED'), reviewStatus: Joi.string().valid('PENDING', 'APPROVED', 'REJECTED'), ...pagination });
export const evidenceReviewSchema = Joi.object({ revision, reviewStatus: Joi.string().valid('PENDING', 'APPROVED', 'REJECTED').required(), remarks: Joi.string().trim().min(3).max(500).required() }).required();
