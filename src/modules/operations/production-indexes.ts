// Register all runtime models, including immutable histories, for inventory checks.
import '../../app.js';
import mongoose from 'mongoose';
import { createTargetIndexes } from '../targets/target-indexes.js';
import { createDashboardIndexes } from '../dashboards/dashboard-indexes.js';

export const additionalIndexes: { collection: string; key: mongoose.IndexDefinition }[] = [
  { collection: 'report_activities', key: { employeeId: 1, branchId: 1, kind: 1, reviewStatus: 1, callEndedAt: 1 } },
  { collection: 'report_activities', key: { employeeId: 1, branchId: 1, kind: 1, reviewStatus: 1, visitCompletedAt: 1 } },
  { collection: 'report_activities', key: { branchId: 1, reviewStatus: 1, callEndedAt: 1 } },
  { collection: 'report_activities', key: { branchId: 1, reviewStatus: 1, visitCompletedAt: 1 } },
  { collection: 'target_evidence', key: { branchId: 1, reviewStatus: 1, occurredAt: 1, milestone: 1 } },
  { collection: 'leads', key: { branchId: 1, createdAt: 1, status: 1 } },
  { collection: 'customers', key: { branchId: 1, createdAt: 1, status: 1 } },
];
export async function createProductionIndexes(): Promise<void> {
  // Additive: no syncIndexes, drops, role mutations, approval or default data.
  for (const model of Object.values(mongoose.models)) { await model.createCollection(); await model.createIndexes(); }
  await createTargetIndexes(); await createDashboardIndexes();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])));
  }
  if (value === undefined) return 'undefined';
  return JSON.stringify(value);
}
interface InstalledIndex {
  key: Record<string, unknown>; unique?: boolean; sparse?: boolean; hidden?: boolean;
  expireAfterSeconds?: number; partialFilterExpression?: unknown; collation?: unknown;
}
export async function inspectProductionDatabase() {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database not connected');
  const hello = await db.command({ hello: 1 }, { timeoutMS: 2000 });
  const transactionCapable = Boolean((hello.setName || hello.msg === 'isdbgrid') && hello.logicalSessionTimeoutMinutes);
  const missing: { collection: string; key: string; reason: string }[] = [];
  let checked = 0;
  for (const model of Object.values(mongoose.models)) {
    const collection = model.collection.collectionName;
    const exists = await db.listCollections({ name: collection }, { nameOnly: true }).hasNext();
    if (!exists) { missing.push({ collection, key: '', reason: 'COLLECTION_MISSING' }); continue; }
    const installed = await db.collection(collection).listIndexes({ maxTimeMS: 2000 }).toArray() as unknown as InstalledIndex[];
    const expected = [...model.schema.indexes(), ...additionalIndexes.filter((item) => item.collection === collection).map((item): [mongoose.IndexDefinition, mongoose.IndexOptions] => [item.key, {}])];
    for (const [key, options] of expected) {
      checked++;
      // Compound key order is significant; filter option object order is not.
      const match = installed.find((item) => JSON.stringify(Object.entries(item.key)) === JSON.stringify(Object.entries(key)));
      const valid = match && !match.hidden && Boolean(match.unique) === Boolean(options.unique) && Boolean(match.sparse) === Boolean(options.sparse) &&
        match.expireAfterSeconds === options.expireAfterSeconds && canonical(match.partialFilterExpression) === canonical(options.partialFilterExpression) &&
        (!options.collation || canonical(match.collation) === canonical(options.collation));
      if (!valid) missing.push({ collection, key: JSON.stringify(key), reason: match ? 'INDEX_OPTIONS_MISMATCH' : 'INDEX_MISSING' });
    }
  }
  return { ready: transactionCapable && missing.length === 0, transactionCapable, checkedIndexes: checked, missing };
}
