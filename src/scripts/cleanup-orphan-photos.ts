import { runInternal } from './run-internal.js';
import { FileService } from '../modules/files/file.service.js';
runInternal(async (config) => { const count = await new FileService(config).cleanup(); process.stdout.write(`Removed ${String(count)} expired orphan photo uploads.\n`); });
