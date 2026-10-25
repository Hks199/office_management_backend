import { runInternal } from './run-internal.js';
import { createIdentityIndexes } from '../modules/auth/identity-indexes.js';
runInternal(async () => { await createIdentityIndexes(); process.stdout.write('Identity indexes created.\n'); });
