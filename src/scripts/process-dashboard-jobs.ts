import { runInternal } from './run-internal.js';
import { DashboardExportService } from '../modules/dashboards/dashboard-export.service.js';
runInternal(async (config) => {
  const exports = new DashboardExportService(config); let count = 0;
  while (count < 5 && await exports.runOne()) count++;
  process.stdout.write(`Processed ${String(count)} dashboard export attempts.\n`);
});
