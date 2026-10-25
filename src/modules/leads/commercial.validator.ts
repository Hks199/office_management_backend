import Joi from 'joi';
import { objectIdSchema, dateSchema, phoneSchema } from '../../shared/utils/validation-schemas.js';
export { normalizePhone, phoneSchema } from '../../shared/utils/validation-schemas.js';
import { LEAD_STATUSES, REFERENCE_CATEGORIES } from './commercial.models.js';
const code = Joi.string().uppercase().pattern(/^[A-Z0-9_-]{1,32}$/);
const decimal = Joi.string().pattern(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/);
export const contactValidation = { customerName: Joi.string().trim().min(1).max(150), mobileNumber: phoneSchema, alternateNumber: phoneSchema.allow(''),
  stateId: objectIdSchema, districtId: objectIdSchema, blockId: objectIdSchema.allow(null), tehsil: Joi.string().trim().max(100).allow(''),
  siteAddress: Joi.string().trim().min(3).max(1000), remarks: Joi.string().trim().max(2000).allow('') };
export const requirementValidation = { requiredCapacityKw: decimal, ratePerKw: decimal, paymentMode: code, panelBrand: code, panelTechnology: code,
  leadSource: code, nextFollowUpAt: dateSchema.allow(null) };
export const requirementsSchema = Joi.object(requirementValidation).fork(['requiredCapacityKw', 'ratePerKw', 'paymentMode', 'panelBrand', 'panelTechnology', 'leadSource'], (field) => field.required()).required();
export const contactSchema = Joi.object(contactValidation).fork(['customerName', 'mobileNumber', 'stateId', 'districtId', 'siteAddress'], (field) => field.required());
export const leadCreateSchema = contactSchema.append({ ...requirementValidation, branchId: objectIdSchema.required(), assignedTo: objectIdSchema.allow(null) })
  .fork(['requiredCapacityKw', 'ratePerKw', 'paymentMode', 'panelBrand', 'panelTechnology', 'leadSource'], (field) => field.required()).required();
const revision = Joi.number().integer().min(0).required(); const reason = Joi.string().trim().min(3).max(500).required();
export const leadUpdateSchema = Joi.object({ ...contactValidation, ...requirementValidation, revision }).min(2).required();
export const assignmentSchema = Joi.object({ revision, reason, assignedTo: objectIdSchema.required() }).required();
export const statusSchema = Joi.object({ revision, reason, status: Joi.string().valid(...LEAD_STATUSES).required() }).required();
export const routeLeadSchema = Joi.object({ revision, reason, branchId: objectIdSchema.required() }).required();
export const conversionSchema = Joi.object({ revision, requirements: requirementsSchema, branchId: objectIdSchema, proposedSalesExecutiveId: objectIdSchema }).required();
export const bulkAssignmentSchema = Joi.object({ items: Joi.array().items(Joi.object({ id: objectIdSchema.required(), revision })).min(1).max(100).unique('id').required(), assignedTo: objectIdSchema.required(), reason }).required();
export const customerStatusSchema = Joi.object({ revision, reason, status: Joi.string().valid('INTERESTED', 'NOT_INTERESTED', 'AVAILABLE').required() }).required();
export const proposalReviewSchema = Joi.object({ status: Joi.string().valid('APPROVED', 'REJECTED').required(), reason }).required();
export const commercialQuerySchema = Joi.object({ page: Joi.number().integer().min(1).max(10000).default(1), limit: Joi.number().integer().min(1).max(100).default(20),
  sortOrder: Joi.string().valid('asc', 'desc').default('desc'), branchId: objectIdSchema, assignedTo: objectIdSchema, createdBy: objectIdSchema,
  stateId: objectIdSchema, districtId: objectIdSchema, blockId: objectIdSchema, status: Joi.string().valid(...LEAD_STATUSES),
  search: Joi.string().trim().min(2).max(150), startDate: dateSchema, endDate: dateSchema, followUpFrom: dateSchema, followUpTo: dateSchema, leadSource: code,
  assignmentState: Joi.string().valid('UNASSIGNED', 'ASSIGNED') })
  .custom((value: { startDate?: string; endDate?: string; followUpFrom?: string; followUpTo?: string }, helpers) =>
    (value.startDate && value.endDate && new Date(value.endDate) <= new Date(value.startDate)) ||
    (value.followUpFrom && value.followUpTo && new Date(value.followUpTo) <= new Date(value.followUpFrom)) ? helpers.error('any.invalid') : value);
export const customerQuerySchema = commercialQuerySchema.keys({ status: Joi.string().valid('AVAILABLE', 'INTERESTED', 'NOT_INTERESTED', 'CONVERTED') });
export const referenceCreateSchema = Joi.object({ category: Joi.string().valid(...REFERENCE_CATEGORIES).required(), code: code.required(), label: Joi.string().trim().min(1).max(100).required() }).required();
export const referenceUpdateSchema = Joi.object({ revision, label: Joi.string().trim().min(1).max(100), isActive: Joi.boolean() }).min(2).required();
export const referenceQuerySchema = Joi.object({ category: Joi.string().valid(...REFERENCE_CATEGORIES).required(), isActive: Joi.boolean().default(true) });
export const workflowSchema = Joi.object({ expectedVersion: Joi.number().integer().min(1).required(), transitions: Joi.array().items(Joi.object({
  from: Joi.string().valid(...LEAD_STATUSES).required(), to: Joi.string().valid(...LEAD_STATUSES).required() })).min(1).max(100).unique((a: { from: string; to: string }, b: { from: string; to: string }) => a.from === b.from && a.to === b.to).required() }).required();
export const duplicateSettingsSchema = Joi.object({ revision, duplicateScope: Joi.string().valid('BRANCH', 'COMPANY').required() }).required();
export const idempotencySchema = Joi.object({ 'idempotency-key': Joi.string().pattern(/^[A-Za-z0-9_-]{16,100}$/).required() }).unknown(true);
