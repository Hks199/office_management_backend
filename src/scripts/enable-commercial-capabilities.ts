import { runInternal } from './run-internal.js';
import { enableDefaultCommercialCapabilities } from '../modules/leads/commercial-capabilities.js';
runInternal(async () => { const changed = await enableDefaultCommercialCapabilities();
  process.stdout.write(`Updated ${String(changed)} default role capability templates. Review/reapprove affected creation policies before creating employees.\n`); });
