import Joi from 'joi';
import { runInternal } from './run-internal.js';
import { bootstrapMd, type BootstrapIdentity } from '../modules/auth/bootstrap.service.js';
import { createIdentityIndexes } from '../modules/auth/identity-indexes.js';
import { emailSchema } from '../modules/auth/auth.validator.js';

runInternal(async (config) => {
  const result = Joi.object<BootstrapIdentity>({ employeeCode: Joi.string().uppercase().pattern(/^[A-Z0-9-]{2,32}$/).required(),
    firstName: Joi.string().trim().min(1).max(80).required(), lastName: Joi.string().trim().min(1).max(80).required(),
    email: emailSchema, mobileNumber: Joi.string().pattern(/^\+[1-9]\d{7,14}$/).required() }).validate({
    employeeCode: process.env.BOOTSTRAP_EMPLOYEE_CODE, firstName: process.env.BOOTSTRAP_FIRST_NAME,
    lastName: process.env.BOOTSTRAP_LAST_NAME, email: process.env.BOOTSTRAP_EMAIL, mobileNumber: process.env.BOOTSTRAP_MOBILE_NUMBER,
  });
  if (result.error) throw new Error('Invalid bootstrap identity');
  await createIdentityIndexes();
  await bootstrapMd(result.value, config.tokenEncryptionKey);
  process.stdout.write('Initial MD provisioned. Deliver its single-use invitation with npm run deliver:credentials.\n');
});
