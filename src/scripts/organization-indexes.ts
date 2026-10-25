import { runInternal } from './run-internal.js';
import { createIdentityIndexes } from '../modules/auth/identity-indexes.js';
import { createOrganizationIndexes } from '../modules/hierarchy/organization-indexes.js';
runInternal(async () => { await createIdentityIndexes(); await createOrganizationIndexes(); process.stdout.write('Organization indexes and Phase 3 metadata migration applied.\n'); });
