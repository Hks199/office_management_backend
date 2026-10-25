import { runInternal } from './run-internal.js';
import { createIdentityIndexes } from '../modules/auth/identity-indexes.js';
import { createOrganizationIndexes } from '../modules/hierarchy/organization-indexes.js';
import { createAttendanceIndexes } from '../modules/attendance/attendance-indexes.js';
import { createCommercialIndexes } from '../modules/leads/commercial-indexes.js';
import { createReportIndexes } from '../modules/reports/report-indexes.js';
runInternal(async () => {
  await createIdentityIndexes(); await createOrganizationIndexes(); await createAttendanceIndexes(); await createCommercialIndexes(); await createReportIndexes();
  process.stdout.write('Reporting collections and indexes initialized. Existing role grants preserved.\n');
});
