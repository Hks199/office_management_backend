import { runInternal } from './run-internal.js';
import { repairMdCreationPolicies } from '../modules/permissions/repair-md-creation-policies.js';

runInternal(async () => {
  const result = await repairMdCreationPolicies(process.argv.includes('--apply'));
  process.stdout.write(`${JSON.stringify(result)}\n`);
});
