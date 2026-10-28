import 'dotenv/config';
import type { AppConfig } from '../config/env.js';
import { ConfigurationError, loadConfig } from '../config/env.js';
import { createLogger } from '../config/logger.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';

type FailureStage = 'configuration' | 'database' | 'command' | 'cleanup';

const databaseCodes = new Map<number | string, string>([
  [13, 'MongoDB authorization denied (code 13). Check the database user permissions for this command.'],
  [18, 'MongoDB authentication failed (code 18). Check the database credentials and authentication database.'],
  [85, 'MongoDB index options conflict (code 85). Review existing indexes before applying this migration.'],
  [86, 'MongoDB index key specification conflicts (code 86). Review existing indexes before applying this migration.'],
  [11000, 'MongoDB duplicate keys prevent index creation (code 11000). Review the conflicting data.'],
  ['ENOTFOUND', 'Database DNS lookup failed. Check MONGODB_URI and DNS resolution.'],
  ['EAI_AGAIN', 'Database DNS lookup temporarily failed. Check DNS resolution.'],
  ['ECONNREFUSED', 'Database connection was refused. Check the database endpoint and network access.'],
  ['ETIMEDOUT', 'Database connection timed out. Check network access and the Atlas IP access list.'],
]);
const databaseNames = new Map<string, string>([
  ['MongoParseError', 'MongoDB connection settings could not be parsed. Check MONGODB_URI and percent-encoded credentials.'],
  ['MongoInvalidArgumentError', 'MongoDB connection options are invalid. Check MONGODB_URI and connection settings.'],
  ['MongoMissingCredentialsError', 'MongoDB credentials are missing. Check MONGODB_URI.'],
  ['MongoServerSelectionError', 'No MongoDB server could be selected. Check the Atlas IP access list, DNS, TLS and database availability.'],
  ['MongooseServerSelectionError', 'No MongoDB server could be selected. Check the Atlas IP access list, DNS, TLS and database availability.'],
  ['MongoNetworkError', 'MongoDB network connection failed. Check DNS, TLS and the Atlas IP access list.'],
  ['MongoNetworkTimeoutError', 'MongoDB network connection timed out. Check network access and database availability.'],
  ['MongoCompatibilityError', 'MongoDB server and driver versions are incompatible. Check the supported database version.'],
]);

function failureMessage(error: unknown, stage: FailureStage): string {
  // Only loadConfig can supply trusted configuration messages. Never log arbitrary
  // driver messages, stacks, hostnames, query details, or URI credentials.
  if (stage === 'configuration' && error instanceof ConfigurationError) return error.message;
  if (stage !== 'configuration' && typeof error === 'object' && error !== null) {
    if ('code' in error && (typeof error.code === 'number' || typeof error.code === 'string')) {
      const detail = databaseCodes.get(error.code);
      if (detail) return detail;
    }
    if ('name' in error && typeof error.name === 'string') {
      const detail = databaseNames.get(error.name);
      if (detail) return detail;
    }
    if (stage === 'database' && error instanceof Error && error.message === 'Production requires transaction-capable MongoDB') {
      return 'Production requires transaction-capable MongoDB. Use a replica set or sharded cluster.';
    }
  }
  return 'Check configuration, database state and command prerequisites; no credentials were printed.';
}

export function runInternal(work: (config: AppConfig) => Promise<void>): void {
  let stage: FailureStage = 'configuration';
  const run = async () => {
    const config = loadConfig(); const logger = createLogger(config);
    stage = 'database';
    let failed = false;
    let failure: unknown;
    try {
      await connectDatabase(config, logger);
      stage = 'command';
      await work(config);
    } catch (error) { failed = true; failure = error; }
    try { await disconnectDatabase(); }
    catch (error) {
      if (!failed) { stage = 'cleanup'; throw error; }
      // Preserve the primary failure, including its stage, if cleanup also fails.
      process.stderr.write('Internal command cleanup also failed; no credentials were printed.\n');
    }
    if (failed) throw failure;
  };
  run().catch((error: unknown) => {
    process.stderr.write(`Internal command failed during ${stage}: ${failureMessage(error, stage)}\n`);
    process.exitCode = 1;
  });
}
