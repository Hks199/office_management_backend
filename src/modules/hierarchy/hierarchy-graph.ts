import { Types, trusted, type ClientSession } from 'mongoose';
import { UserModel } from '../users/user.model.js';
import { managerIds } from '../users/reporting-managers.js';

export async function traverseHierarchy(id: Types.ObjectId, upwards: boolean, session?: ClientSession) {
  // Read both fields so existing single-manager employees need no data migration.
  const root = await UserModel.findById(id).select('_id reportingManagerId reportingManagerIds').session(session ?? null).lean();
  if (!root) return [];
  type Node = { _id: Types.ObjectId; reportingManagerId?: Types.ObjectId | null | undefined; reportingManagerIds: Types.ObjectId[];
    isActive: boolean; employmentStatus: string; bootstrapKey?: string | null | undefined };
  const nodes = new Map<string, Node>();
  const edges = new Map<string, string[]>();
  let frontier = [id];
  for (let level = 0; level <= 20 && frontier.length; level++) {
    const rows = await UserModel.find(upwards
      ? { _id: trusted({ $in: frontier.flatMap((current) => managerIds(current.equals(id) ? root : nodes.get(current.toHexString()) ?? {})) }) }
      : { $or: [{ reportingManagerId: trusted({ $in: frontier }) }, { reportingManagerIds: trusted({ $in: frontier }) }] })
      .select('_id reportingManagerId reportingManagerIds isActive employmentStatus +bootstrapKey').session(session ?? null).maxTimeMS(3000).lean();
    const next: Types.ObjectId[] = [];
    for (const row of rows) {
      const key = row._id.toHexString();
      if (!nodes.has(key)) { nodes.set(key, row); next.push(row._id); }
    }
    const children = new Map(frontier.map((current) => [current.toHexString(), [] as string[]]));
    if (!upwards) for (const row of rows) for (const manager of managerIds(row)) {
      children.get(manager.toHexString())?.push(row._id.toHexString());
    }
    for (const current of frontier) {
      const key = current.toHexString();
      edges.set(key, upwards
        ? managerIds(current.equals(id) ? root : nodes.get(key) ?? {}).map((manager) => manager.toHexString())
        : children.get(key) ?? []);
    }
    frontier = next;
  }
  // Longest path matters for the depth limit when reporting chains converge.
  const depths = new Map<string, number>();
  const visit = (key: string, depth: number, path: Set<string>) => {
    if (depth > 20) return;
    if (path.has(key)) { depths.set(key, 20); return; }
    if ((depths.get(key) ?? -1) >= depth && key !== id.toHexString()) return;
    if (depth >= 0) depths.set(key, depth);
    const nextPath = new Set(path).add(key);
    for (const child of edges.get(key) ?? []) visit(child, depth + 1, nextPath);
  };
  visit(id.toHexString(), -1, new Set());
  return [...nodes.values()].map((node) => ({ ...node, depth: depths.get(node._id.toHexString()) ?? 20 }));
}
