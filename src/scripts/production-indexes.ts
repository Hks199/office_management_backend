import { runInternal } from './run-internal.js';
import { createProductionIndexes } from '../modules/operations/production-indexes.js';
runInternal(async () => {
  await createProductionIndexes();
  process.stdout.write('Production collections/indexes initialized. Existing grants, approvals, data and extra indexes preserved.\n');
});
