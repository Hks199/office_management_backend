import Joi from 'joi';
export const uploadSchema = Joi.object({ purpose: Joi.string().valid('ATTENDANCE_CHECK_IN', 'ATTENDANCE_CHECK_OUT').required(),
  filename: Joi.string().pattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}\.(?:jpg|jpeg|png|webp)$/i).required(),
  contentType: Joi.string().valid('image/jpeg', 'image/png', 'image/webp').required(), size: Joi.number().integer().min(12).max(5242880).required(),
  checksumSHA256: Joi.string().pattern(/^[A-Za-z0-9+/]{43}=$/).required(),
}).required();
