import { runInternal } from './run-internal.js';
import { S3CommercialStorage } from '../modules/csv-imports/commercial-storage.js';
import { ImportWorker } from '../modules/csv-imports/import.worker.js';
import { ExportService } from '../modules/csv-imports/export.service.js';
runInternal(async (config) => {
  const storage = new S3CommercialStorage(config); const imports = new ImportWorker(storage); const exports = new ExportService(config, storage);
  let processed = 0;
  for (let index = 0; index < 5; index++) { const imported = await imports.runOne(); const exported = await exports.runOne();
    processed += Number(imported) + Number(exported); if (!imported && !exported) break; }
  process.stdout.write(`Processed ${String(processed)} commercial job attempts.\n`);
});
