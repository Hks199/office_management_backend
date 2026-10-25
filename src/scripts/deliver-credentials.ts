import { runInternal } from './run-internal.js';
import { deliverCredentials, smtpDelivery } from '../jobs/credential-delivery.js';
runInternal(async (config) => {
  const sent = await deliverCredentials(config, smtpDelivery(config));
  process.stdout.write(`Credential messages sent: ${String(sent)}. Check credential_deliveries status for retries.\n`);
});
