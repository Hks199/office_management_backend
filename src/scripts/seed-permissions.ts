import { runInternal } from './run-internal.js';
import { createIdentityIndexes } from '../modules/auth/identity-indexes.js';
import { seedPermissions } from '../modules/permissions/seed.service.js';

runInternal(async () => {
  await createIdentityIndexes(); await seedPermissions();
  process.stdout.write('Controlled permission registry synchronized.\n');
});
