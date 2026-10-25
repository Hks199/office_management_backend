import Joi from 'joi';

export function normalizePhone(value: string): string {
  const cleaned = value.replace(/[\s()-]/g, '');
  return /^\d{10}$/.test(cleaned) ? `+91${cleaned}` : cleaned;
}
export const phoneSchema = Joi.string().max(30).custom((value: string, helpers) =>
  /^\+[1-9]\d{7,14}$/.test(normalizePhone(value)) ? normalizePhone(value) : helpers.error('string.pattern.base'));

export const objectIdSchema = Joi.string().lowercase().hex().length(24);
export const dateSchema = Joi.string().isoDate().custom((value: unknown, helpers) => {
  const original: unknown = helpers.original;
  if (typeof original !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.+(?:Z|[+-]\d{2}:\d{2}))?$/.test(original)) return helpers.error('date.format');
  const day = original.slice(0, 10); const calendar = new Date(`${day}T00:00:00Z`);
  return !Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== day ? helpers.error('date.format') : value;
});
export const locationSchema = Joi.object({
  latitude: Joi.number().min(-90).max(90).required(),
  longitude: Joi.number().min(-180).max(180).required(),
  accuracyMeters: Joi.number().min(0).max(10000),
}).unknown(false);

export function paginationSchema(sortFields: readonly string[]) {
  return Joi.object({
    page: Joi.number().integer().min(1).max(10000).default(1),
    limit: Joi.number().integer().min(1).max(100).default(20),
    sortBy: Joi.string().valid(...sortFields).default(sortFields[0]),
    sortOrder: Joi.string().valid('asc', 'desc').default('desc'),
    search: Joi.string().trim().min(2).max(100),
    startDate: dateSchema,
    endDate: dateSchema,
  }).unknown(false);
}
