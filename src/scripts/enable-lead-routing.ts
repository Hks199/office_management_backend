import { runInternal } from './run-internal.js';
import { LeadModel } from '../modules/leads/commercial.models.js';
import { enableBranchLeadRouting } from '../modules/leads/enable-lead-routing.js';
runInternal(async () => {
  await LeadModel.createIndexes();
  const count = await enableBranchLeadRouting();
  process.stdout.write(`Branch lead routing enabled; ${String(count)} system roles updated. Telecallers route leads; branch managers assign sales executives.\n`);
});
