import Joi from 'joi';
import { businessDay } from '../targets/target.validator.js';
import { objectIdSchema } from '../../shared/utils/validation-schemas.js';
import { businessDate } from '../../shared/utils/business-date.js';
import { LEAD_STATUSES } from '../leads/commercial.models.js';
import { TARGET_TYPES } from '../targets/target.types.js';
import { DASHBOARD_KINDS, type DashboardQuery } from './dashboard.types.js';
export const nextDay = (day: string) => new Date(new Date(`${day}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
export const dashboardQuerySchema = Joi.object({
  startDate: businessDay.default(() => `${businessDate().slice(0, 7)}-01`), endDate: businessDay.default(() => nextDay(businessDate())),
  branchId: objectIdSchema, employeeId: objectIdSchema, managerId: objectIdSchema, roleId: objectIdSchema, stateId: objectIdSchema, districtId: objectIdSchema, blockId: objectIdSchema,
  search: Joi.string().trim().min(2).max(100), leadStatus: Joi.array().items(Joi.string().valid(...LEAD_STATUSES)).min(1).max(LEAD_STATUSES.length).unique().single(),
  leadSource: Joi.string().pattern(/^[A-Z0-9_-]{1,32}$/), targetType: Joi.string().valid(...TARGET_TYPES), compare: Joi.boolean().default(true),
  page: Joi.number().integer().min(1).max(10000).default(1), limit: Joi.number().integer().min(1).max(100).default(20),
  sortBy: Joi.string().valid('approvedCalls', 'approvedVisits', 'approvedConversions', 'salesValue', 'name').default('approvedConversions'), sortOrder: Joi.string().valid('asc', 'desc').default('desc'),
}).custom((query: DashboardQuery, helpers) => {
  const days = (Date.parse(query.endDate) - Date.parse(query.startDate)) / 86400000;
  return days < 1 || days > 366 ? helpers.error('date.range') : query;
});
export const dashboardExportSchema = Joi.object({ kind: Joi.string().valid(...DASHBOARD_KINDS).required(), query: dashboardQuerySchema.required() }).required();
export const calendarSchema = Joi.object({ revision: Joi.number().integer().min(0).required(),
  workingWeekdays: Joi.array().items(Joi.number().integer().min(1).max(7)).min(1).max(7).unique().required(),
  holidays: Joi.array().items(businessDay).max(366).unique().required() }).required();
