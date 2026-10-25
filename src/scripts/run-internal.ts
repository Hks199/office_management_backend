import 'dotenv/config';
import type { AppConfig } from '../config/env.js';
import { loadConfig } from '../config/env.js';
import { createLogger } from '../config/logger.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';

export function runInternal(work: (config: AppConfig) => Promise<void>): void {
  const run = async () => {
    const config = loadConfig(); const logger = createLogger(config);
    try { await connectDatabase(config, logger); await work(config); }
    finally { await disconnectDatabase(); }
  };
  run().catch(() => {
    process.stderr.write('Internal command failed. Check configuration, database state and command prerequisites; no credentials were printed.\n');
    process.exitCode = 1;
  });
}
