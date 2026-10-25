import Joi from 'joi';

export const emailSchema = Joi.string().trim().lowercase().email({ tlds: { allow: false } }).max(254).required();
export const passwordSchema = Joi.string().min(12).max(128).pattern(/\S/).required();
export const loginSchema = Joi.object({ email: emailSchema, password: Joi.string().min(1).max(128).required() }).required();
export const forgotSchema = Joi.object({ email: emailSchema }).required();
export const resetSchema = Joi.object({ token: Joi.string().pattern(/^[A-Za-z0-9_-]{43}$/).required(), newPassword: passwordSchema }).required();
export const changePasswordSchema = Joi.object({ currentPassword: Joi.string().min(1).max(128).required(), newPassword: passwordSchema }).required();
