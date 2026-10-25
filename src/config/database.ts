import mongoose from 'mongoose';
import type { AppConfig } from './env.js';
import type { Logger } from 'pino';
import { databaseTelemetry } from '../modules/operations/telemetry.js';

let stopMonitoring: (() => void) | undefined;

export async function connectDatabase(config: AppConfig, logger: Logger): Promise<void> {
  mongoose.set('strictQuery', true);
  mongoose.set('sanitizeFilter', true);
  mongoose.set('bufferCommands', false);
  mongoose.connection.on('error', () => { logger.error('MongoDB connection error'); });
  mongoose.connection.on('disconnected', () => { logger.warn('MongoDB disconnected'); });
  await mongoose.connect(config.mongodbUri, {
    maxPoolSize: config.mongoMaxPoolSize,
    serverSelectionTimeoutMS: config.mongoServerSelectionTimeoutMs,
    socketTimeoutMS: 15000,
    waitQueueTimeoutMS: config.mongoWaitQueueTimeoutMs,
    monitorCommands: true,
    autoIndex: config.nodeEnv !== 'production',
    autoCreate: config.nodeEnv !== 'production',
  });
  const db = mongoose.connection.db;
  if (config.nodeEnv === 'production') {
    const hello = await db?.command({ hello: 1 }, { timeoutMS: 2000 });
    if (!hello || (!hello.setName && hello.msg !== 'isdbgrid') || !hello.logicalSessionTimeoutMinutes) {
      throw new Error('Production requires transaction-capable MongoDB');
    }
  }
  stopMonitoring?.();
  Object.assign(databaseTelemetry, { connections: 0, checkedOut: 0, checkoutFailures: 0,
    commands: 0, commandFailures: 0, slowCommands: 0, durationMsSum: 0 });
  const client = mongoose.connection.getClient();
  // Install pool gauges after connect; seed already-open pool connections from zero, then
  // report only observed deltas. They are operational indicators, not server-wide totals.
  const created = () => { databaseTelemetry.connections++; };
  const closed = () => { databaseTelemetry.connections = Math.max(0, databaseTelemetry.connections - 1); };
  const checkedOut = () => { databaseTelemetry.checkedOut++; };
  const checkedIn = () => { databaseTelemetry.checkedOut = Math.max(0, databaseTelemetry.checkedOut - 1); };
  const checkoutFailed = () => { databaseTelemetry.checkoutFailures++; };
  const command = (event: { duration: number; commandName: string }, failed: boolean) => {
    databaseTelemetry.commands++; databaseTelemetry.durationMsSum += event.duration;
    if (failed) databaseTelemetry.commandFailures++;
    if (event.duration >= config.slowQueryMs) {
      databaseTelemetry.slowCommands++;
      const operation = ['find', 'aggregate', 'getMore', 'insert', 'update', 'delete', 'commitTransaction', 'abortTransaction'].includes(event.commandName) ? event.commandName : 'other';
      logger.warn({ operation, durationMs: Math.round(event.duration), failed }, 'Slow database command');
    }
  };
  const succeeded = (event: { duration: number; commandName: string }) => { command(event, false); };
  const failed = (event: { duration: number; commandName: string }) => { command(event, true); };
  client.on('connectionCreated', created); client.on('connectionClosed', closed);
  client.on('connectionCheckedOut', checkedOut); client.on('connectionCheckedIn', checkedIn);
  client.on('connectionCheckOutFailed', checkoutFailed);
  client.on('commandSucceeded', succeeded); client.on('commandFailed', failed);
  stopMonitoring = () => {
    client.off('connectionCreated', created); client.off('connectionClosed', closed);
    client.off('connectionCheckedOut', checkedOut); client.off('connectionCheckedIn', checkedIn);
    client.off('connectionCheckOutFailed', checkoutFailed);
    client.off('commandSucceeded', succeeded); client.off('commandFailed', failed);
  };
  logger.info('MongoDB connected');
}

export async function databaseReady(): Promise<boolean> {
  const db = mongoose.connection.db;
  if (mongoose.connection.readyState !== mongoose.ConnectionStates.connected || !db) return false;
  try {
    await db.command({ ping: 1 }, { timeoutMS: 2000 });
    return true;
  } catch { return false; }
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
  stopMonitoring?.(); stopMonitoring = undefined;
}
