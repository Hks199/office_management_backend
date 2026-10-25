import { runInternal } from './run-internal.js';
import { createIdentityIndexes } from '../modules/auth/identity-indexes.js';
import { createOrganizationIndexes } from '../modules/hierarchy/organization-indexes.js';
import { createAttendanceIndexes } from '../modules/attendance/attendance-indexes.js';
runInternal(async () => { await createIdentityIndexes(); await createOrganizationIndexes(); await createAttendanceIndexes();
  process.stdout.write('Attendance and file indexes applied.\n'); });
