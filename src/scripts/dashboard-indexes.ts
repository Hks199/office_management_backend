import { runInternal } from './run-internal.js';
import { createIdentityIndexes } from '../modules/auth/identity-indexes.js';
import { createOrganizationIndexes } from '../modules/hierarchy/organization-indexes.js';
import { createAttendanceIndexes } from '../modules/attendance/attendance-indexes.js';
import { createCommercialIndexes } from '../modules/leads/commercial-indexes.js';
import { createReportIndexes } from '../modules/reports/report-indexes.js';
import { createTargetIndexes } from '../modules/targets/target-indexes.js';
import { createDashboardIndexes } from '../modules/dashboards/dashboard-indexes.js';
runInternal(async () => {
  await createIdentityIndexes(); await createOrganizationIndexes(); await createAttendanceIndexes(); await createCommercialIndexes(); await createReportIndexes(); await createTargetIndexes(); await createDashboardIndexes();
  process.stdout.write('Dashboard collections and indexes initialized. Existing grants preserved; attendance calendars remain explicitly configured.\n');
});
