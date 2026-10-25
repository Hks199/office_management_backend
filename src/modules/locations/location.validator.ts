import Joi from 'joi';
import { objectIdSchema } from '../../shared/utils/validation-schemas.js';
import type { LocationKind } from './location.model.js';
export const locationCreateSchema = (kind: LocationKind) => Joi.object({
  code: Joi.string().uppercase().pattern(/^[A-Z0-9_-]{1,32}$/).required(), name: Joi.string().trim().min(1).max(100).required(),
  sourceVersion: Joi.string().max(100), ...(kind === 'districts' ? { stateId: objectIdSchema.required() } : {}),
  ...(kind === 'blocks' ? { districtId: objectIdSchema.required(), kind: Joi.string().valid('BLOCK', 'TEHSIL').required() } : {}),
}).required();
export const locationQuerySchema = (kind: LocationKind) => Joi.object({
  page: Joi.number().integer().min(1).max(10000).default(1), limit: Joi.number().integer().min(1).max(100).default(20),
  sortOrder: Joi.string().valid('asc', 'desc').default('asc'), isActive: Joi.boolean().default(true), search: Joi.string().trim().min(2).max(100),
  ...(kind === 'districts' ? { stateId: objectIdSchema.required() } : {}), ...(kind === 'blocks' ? { districtId: objectIdSchema.required() } : {}),
});
export const locationUpdateSchema = Joi.object({ revision: Joi.number().integer().min(0).required(),
  name: Joi.string().trim().min(1).max(100), isActive: Joi.boolean() }).min(2).required();
