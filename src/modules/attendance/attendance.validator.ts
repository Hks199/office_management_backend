import Joi from 'joi';
import { objectIdSchema, dateSchema } from '../../shared/utils/validation-schemas.js';
import { businessDate } from '../../shared/utils/business-date.js';
const timestamp = dateSchema.custom((value: string, helpers) => typeof helpers.original === 'string' && helpers.original.includes('T') ? value : helpers.error('date.format'));
export const evidenceSchema = Joi.object({ photoFileId: objectIdSchema.required(), capturedAt: timestamp.required(),
  location: Joi.object({ latitude: Joi.number().min(-90).max(90).required(), longitude: Joi.number().min(-180).max(180).required(),
    accuracyMeters: Joi.number().min(0).max(100000) }).required() }).required();
export const attendanceQuerySchema = Joi.object({ month: Joi.string().pattern(/^20\d{2}-(?:0[1-9]|1[0-2])$/).default(() => businessDate().slice(0, 7)),
  employeeId: objectIdSchema, branchId: objectIdSchema, status: Joi.string().valid('OPEN', 'COMPLETED'),
  reviewStatus: Joi.string().valid('PENDING', 'APPROVED', 'REJECTED'), lateArrival: Joi.boolean(), earlyExit: Joi.boolean(),
  page: Joi.number().integer().min(1).max(10000).default(1), limit: Joi.number().integer().min(1).max(100).default(20),
  sortOrder: Joi.string().valid('asc', 'desc').default('desc') });
const revision = Joi.number().integer().min(0).required(); const reason = Joi.string().trim().min(3).max(500).required();
export const reviewSchema = Joi.object({ revision, reviewStatus: Joi.string().valid('APPROVED', 'REJECTED', 'PENDING').required(), reason }).required();
export const correctionSchema = Joi.object({ revision, effectiveCheckInAt: timestamp.required(), effectiveCheckOutAt: timestamp.allow(null).required(), reason }).required();
