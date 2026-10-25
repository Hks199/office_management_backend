import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { connectDatabase, databaseReady, disconnectDatabase } from '../../src/config/database.js';
import { createLogger } from '../../src/config/logger.js';
import { testConfig } from '../helpers.js';

let replicaSet: MongoMemoryReplSet | undefined;

beforeAll(async () => {
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
}, 180000);

afterAll(async () => {
  await disconnectDatabase();
  await replicaSet?.stop();
});

it('connects to a real replica set, supports transactions and reports disconnected readiness', async () => {
  if (!replicaSet) throw new Error('Replica set not initialized');
  expect(await databaseReady()).toBe(false);
  const config = testConfig({ mongodbUri: replicaSet.getUri('sunvika-test') });
  await connectDatabase(config, createLogger(config));
  expect(await databaseReady()).toBe(true);
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database not connected');
  await db.createCollection('foundation_probe');
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await db.collection('foundation_probe').insertOne({ verified: true }, { session });
    });
    expect(await db.collection('foundation_probe').countDocuments({ verified: true })).toBe(1);
  } finally { await session.endSession(); }
  await disconnectDatabase();
  expect(await databaseReady()).toBe(false);
}, 30000);
