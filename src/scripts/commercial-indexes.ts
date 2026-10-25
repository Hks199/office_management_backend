import { runInternal } from './run-internal.js';
import { createIdentityIndexes } from '../modules/auth/identity-indexes.js';
import { createOrganizationIndexes } from '../modules/hierarchy/organization-indexes.js';
import { createAttendanceIndexes } from '../modules/attendance/attendance-indexes.js';
import { createCommercialIndexes } from '../modules/leads/commercial-indexes.js';
runInternal(async () => { await createIdentityIndexes(); await createOrganizationIndexes(); await createAttendanceIndexes(); await createCommercialIndexes();
  process.stdout.write('Commercial collections, indexes, permission registry and default workflow initialized. Existing role grants were preserved.\n'); });
