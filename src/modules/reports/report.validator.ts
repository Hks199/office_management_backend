import Joi from 'joi';
import { dateSchema, objectIdSchema } from '../../shared/utils/validation-schemas.js';
import { CALL_OUTCOMES, INTEREST, VISIT_OUTCOMES } from './report.model.js';
export const timestamp = dateSchema.custom((value: string, helpers) => typeof helpers.original === 'string' && helpers.original.includes('T') ? value : helpers.error('date.format'));
export const locationSchema = Joi.object({ latitude: Joi.number().min(-90).max(90).required(), longitude: Joi.number().min(-180).max(180).required(), accuracyMeters: Joi.number().min(0).max(100000) });
const interest = Joi.string().valid(...INTEREST).required(); const revision = Joi.number().integer().min(0).required();
const day = Joi.string().pattern(/^20\d{2}-\d{2}-\d{2}$/).custom((value: string, helpers) => {
  const parsed = new Date(`${value}T00:00:00Z`); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : helpers.error('date.format');
});
export const callSchema = Joi.object({ customerId: objectIdSchema.required(), callStartedAt: timestamp.required(), callEndedAt: timestamp.required(),
  callOutcome: Joi.string().valid(...CALL_OUTCOMES).required(), customerInterest: interest.optional(), followUpAt: timestamp.allow(null), remarks: Joi.string().trim().max(2000).allow('').default('') }).required();
export const visitSchema = Joi.object({ leadId: objectIdSchema.required(), location: locationSchema.required(), clientCapturedAt: timestamp.required() }).required();
export const completeSchema = Joi.object({ revision, photoFileIds: Joi.array().items(objectIdSchema.required()).min(1).max(5).unique().required(),
  location: locationSchema.required(), clientCapturedAt: timestamp.required(), discussionNotes: Joi.string().trim().min(3).max(4000).required(), customerInterest: interest,
  installationReadiness: Joi.string().valid('UNKNOWN', 'READY', 'NOT_READY').required(), visitOutcome: Joi.string().valid(...VISIT_OUTCOMES).required(),
  requiredCapacityKw: Joi.string().pattern(/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/).required(), nextFollowUpAt: timestamp.allow(null) }).required();
export const reviewSchema = Joi.object({ revision, reviewStatus: Joi.string().valid('PENDING', 'APPROVED', 'REJECTED').required(), remarks: Joi.string().trim().min(3).max(500).required() }).required();
export const reportQuerySchema = Joi.object({ employeeId: objectIdSchema, customerId: objectIdSchema, leadId: objectIdSchema, branchId: objectIdSchema,
  callOutcome: Joi.string().valid(...CALL_OUTCOMES), visitOutcome: Joi.string().valid(...VISIT_OUTCOMES), reviewStatus: Joi.string().valid('PENDING', 'APPROVED', 'REJECTED'),
  from: day, to: day,
  page: Joi.number().integer().min(1).max(10000).default(1), limit: Joi.number().integer().min(1).max(100).default(20), sortOrder: Joi.string().valid('asc', 'desc').default('desc'),
}).custom((value: ReportQuery, helpers) => value.from && value.to && value.from > value.to ? helpers.error('date.order') : value);
export interface Location { latitude: number; longitude: number; accuracyMeters?: number }
export interface CallInput { customerId: string; callStartedAt: string; callEndedAt: string; callOutcome: typeof CALL_OUTCOMES[number]; customerInterest?: typeof INTEREST[number]; followUpAt?: string | null; remarks: string }
export interface VisitInput { leadId: string; location: Location; clientCapturedAt: string }
export interface CompleteInput { revision: number; photoFileIds: string[]; location: Location; clientCapturedAt: string; discussionNotes: string; customerInterest: typeof INTEREST[number]; installationReadiness: 'UNKNOWN' | 'READY' | 'NOT_READY'; visitOutcome: typeof VISIT_OUTCOMES[number]; requiredCapacityKw: string; nextFollowUpAt?: string | null }
export interface ReviewInput { revision: number; reviewStatus: 'PENDING' | 'APPROVED' | 'REJECTED'; remarks: string }
export interface ReportQuery { employeeId?: string; customerId?: string; leadId?: string; branchId?: string; callOutcome?: string; visitOutcome?: string; reviewStatus?: string; from?: string; to?: string; page: number; limit: number; sortOrder: 'asc' | 'desc' }
