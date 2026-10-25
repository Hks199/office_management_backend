import { runInternal } from './run-internal.js';
import { inspectProductionDatabase } from '../modules/operations/production-indexes.js';
runInternal(async () => {
  const result = await inspectProductionDatabase(); process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ready) process.exitCode = 1;
});
