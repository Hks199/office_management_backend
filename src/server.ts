import 'dotenv/config';
import { loadConfig } from './config/env.js';
import { createLogger } from './config/logger.js';
import { connectDatabase, databaseReady, disconnectDatabase } from './config/database.js';
import { createApp } from './app.js';
import { ServiceRuntime } from './runtime.js';
import { CredentialDeliveryWorker } from './jobs/credential-delivery-worker.js';
import { deliverCredentials, smtpDelivery } from './jobs/credential-delivery.js';
import { CommercialJobsWorker } from './jobs/commercial-jobs-worker.js';
import { S3CommercialStorage } from './modules/csv-imports/commercial-storage.js';
import { ImportWorker } from './modules/csv-imports/import.worker.js';
import { ExportService } from './modules/csv-imports/export.service.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  let credentialWorker: CredentialDeliveryWorker | undefined;
  let commercialWorker: CommercialJobsWorker | undefined;
  if (config.commercialJobsEnabled && config.awsRegion && config.s3Bucket) {
    const storage = new S3CommercialStorage(config);
    const imports = new ImportWorker(storage); const exports = new ExportService(config, storage);
    commercialWorker = new CommercialJobsWorker(config.commercialJobsIntervalMs, logger, async (signal) => {
      let processed = Number(await imports.runOne());
      if (!signal.aborted) processed += Number(await exports.runOne());
      return processed;
    });
  } else if (config.commercialJobsEnabled) {
    logger.warn('Automatic commercial jobs unavailable: configure AWS_REGION and S3_BUCKET');
  }
  if (config.credentialDeliveryEnabled) {
    if (config.smtpHost && config.mailFrom) {
      const send = smtpDelivery(config);
      credentialWorker = new CredentialDeliveryWorker(config.credentialDeliveryIntervalMs, logger,
        (signal) => deliverCredentials(config, send, 50, signal,
          (code) => { logger.warn({ code }, 'Credential email delivery failed; check SMTP configuration and delivery queue'); }));
    } else {
      logger.warn('Automatic credential delivery unavailable: configure SMTP_HOST and MAIL_FROM');
    }
  }
  const app = createApp(config, {
    logger,
    isDatabaseReady: async () => runtime.acceptingRequests && await databaseReady(),
  });
  const runtime = new ServiceRuntime(config, logger, {
    app, connect: () => connectDatabase(config, logger), disconnect: disconnectDatabase,
    startBackground: () => { credentialWorker?.start(); commercialWorker?.start(); },
    stopBackground: async () => { await Promise.all([credentialWorker?.stop(), commercialWorker?.stop()]); },
    forceExit: () => { process.exit(1); },
  });
  const shutdown = (code: number) => { void runtime.shutdown(code).then((result) => { process.exitCode = result; }); };
  // Termination during startup must not subsequently bind HTTP.
  process.once('SIGINT', () => { shutdown(0); });
  process.once('SIGTERM', () => { shutdown(0); });
  process.once('uncaughtException', () => { logger.fatal('Uncaught exception'); shutdown(1); });
  process.once('unhandledRejection', () => { logger.fatal('Unhandled rejection'); shutdown(1); });
  runtime.server.on('error', () => { logger.fatal('HTTP server error'); shutdown(1); });
  try {
    await runtime.start();
  } catch {
    logger.fatal('Startup failed; check environment and database connectivity');
    await runtime.shutdown(1); process.exitCode = 1;
  }
}

main().catch(() => {
  // Configuration validation may fail before a logger exists. Never dump environment values.
  process.stderr.write('Startup failed: invalid configuration. See .env.example for required variables.\n');
  process.exitCode = 1;
});
