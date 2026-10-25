import { Types, trusted, type ClientSession } from 'mongoose';
import { UserModel } from '../../modules/users/user.model.js';

// Parent records must already be authorized. These related identity labels do
// not grant directory access; inactive employees retain historical attribution.
export async function withEmployeeLabels<T extends object>(records: T[], fields: readonly string[], session?: ClientSession) {
  if (!records.length) return [];
  const ids = new Set<string>();
  for (const record of records) for (const field of fields) {
    const value = (record as Record<string, unknown>)[field];
    if (value instanceof Types.ObjectId) ids.add(value.toHexString());
  }
  const users = await UserModel.find({ _id: trusted({ $in: [...ids].map(id => new Types.ObjectId(id)) }) })
    .select('_id firstName lastName employeeCode').session(session ?? null).lean();
  const people = new Map(users.map(user => [user._id.toHexString(), user]));
  return records.map(record => {
    const labels: Record<string, string | null> = {};
    for (const field of fields) {
      if (!(field in record)) continue;
      const id = (record as Record<string, unknown>)[field];
      const person = id instanceof Types.ObjectId ? people.get(id.toHexString()) : undefined;
      const prefix = field.replace(/Id$/, '');
      labels[`${prefix}Name`] = person ? `${person.firstName} ${person.lastName}`.trim() : null;
      labels[`${prefix}Code`] = person?.employeeCode ?? null;
    }
    return { ...record, ...labels };
  });
}
