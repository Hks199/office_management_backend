import { runInternal } from './run-internal.js';
import { EmployeePanelModel } from '../modules/auth/employee-panel.model.js';
import { enableEmployeePanels } from '../modules/permissions/enable-employee-panels.js';

runInternal(async () => {
  await EmployeePanelModel.createCollection(); await EmployeePanelModel.createIndexes();
  process.stdout.write(`${JSON.stringify(await enableEmployeePanels())}\n`);
});
