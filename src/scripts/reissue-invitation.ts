import { runInternal } from './run-internal.js';
import { AuthService } from '../modules/auth/auth.service.js';
runInternal(async (config) => {
  const employeeCode = process.env.INVITATION_EMPLOYEE_CODE?.trim().toUpperCase();
  if (!employeeCode || !/^[A-Z0-9-]{2,32}$/.test(employeeCode)) throw new Error('INVITATION_EMPLOYEE_CODE is required');
  await new AuthService(config).reissueInvitation(employeeCode, { requestId: 'internal-invitation-reissue' });
  process.stdout.write('Replacement invitation queued; previous invitations invalidated. Run the credential delivery worker.\n');
});
