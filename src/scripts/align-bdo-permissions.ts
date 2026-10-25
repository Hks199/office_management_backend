import { runInternal } from './run-internal.js';
import { alignBdoPermissions } from '../modules/permissions/align-bdo-permissions.js';

runInternal(async () => {
  const result = await alignBdoPermissions(process.argv.includes('--apply'));
  process.stdout.write(`${JSON.stringify(result)}\n`);
});
