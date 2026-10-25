import { runInternal } from './run-internal.js';
import { ConfirmedCustomerModel } from '../modules/sales-customers/customer.model.js';
import { backfillConfirmedCustomers } from '../modules/sales-customers/customer-lifecycle.js';
runInternal(async () => {
  await ConfirmedCustomerModel.createCollection(); await ConfirmedCustomerModel.createIndexes();
  const count = await backfillConfirmedCustomers();
  process.stdout.write(`Customer indexes initialized; ${String(count)} existing converted leads linked to customer records.\n`);
});
