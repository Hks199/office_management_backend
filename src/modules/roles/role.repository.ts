import mongoose, { Types, trusted, type ClientSession } from 'mongoose';
import { RoleModel } from './role.model.js';
import { RolePolicyModel } from './role-policy.model.js';
import { UserModel } from '../users/user.model.js';
import { PermissionModel } from '../permissions/permission.model.js';
import { SecurityStateModel } from '../auth/auth.models.js';
import type { PolicyInput, PolicyQuery, RoleCreate, RoleUpdate, RoleQuery } from './role.types.js';

export class RoleRepository {
  transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> { return mongoose.connection.transaction(work); }
  async lock(session: ClientSession): Promise<void> {
    await SecurityStateModel.updateOne({ _id: 'administration' }, { $inc: { revision: 1 } }, { upsert: true, session });
  }
  role(id: Types.ObjectId, session?: ClientSession) { return RoleModel.findById(id).session(session ?? null).lean(); }
  permissions(ids?: Types.ObjectId[]) {
    return PermissionModel.find(ids ? { _id: trusted({ $in: ids }) } : {}).sort({ code: 1 }).lean();
  }
  async list(query: RoleQuery) {
    const filter = { ...(query.search ? { name: trusted({ $regex: `^${query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, $options: 'i' }) } : {}),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }) };
    const [data, total] = await Promise.all([
      RoleModel.find(filter).sort({ [query.sortBy]: query.sortOrder === 'asc' ? 1 : -1, _id: 1 })
        .skip((query.page - 1) * query.limit).limit(query.limit).lean(),
      RoleModel.countDocuments(filter),
    ]);
    return { data, total };
  }
  async create(input: RoleCreate, actorId: Types.ObjectId, session: ClientSession) {
    const [role] = await RoleModel.create([{ ...input, createdBy: actorId }], { session });
    if (!role) throw new Error('Role insertion failed');
    return role.toObject();
  }
  update(id: Types.ObjectId, input: RoleUpdate, session: ClientSession) {
    const { revision, ...changes } = input;
    return RoleModel.findOneAndUpdate({ _id: id, revision }, { $set: changes, $inc: { revision: 1 } },
      { returnDocument: 'after', runValidators: true, session }).lean();
  }
  async referenced(id: Types.ObjectId, session: ClientSession): Promise<boolean> {
    return Boolean(await UserModel.exists({ roleId: id }).session(session) ||
      await RolePolicyModel.exists({ isActive: true, $or: [{ creatorRoleId: id }, { targetRoleId: id }, { allowedManagerRoleIds: id }] }).session(session));
  }
  async policies(query: PolicyQuery) {
    const filter = { ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.creatorRoleId ? { creatorRoleId: new Types.ObjectId(query.creatorRoleId) } : {}),
      ...(query.targetRoleId ? { targetRoleId: new Types.ObjectId(query.targetRoleId) } : {}) };
    const [data, total] = await Promise.all([
      RolePolicyModel.find(filter).sort({ createdAt: query.sortOrder === 'asc' ? 1 : -1, _id: 1 })
        .skip((query.page - 1) * query.limit).limit(query.limit).lean(), RolePolicyModel.countDocuments(filter),
    ]);
    return { data, total };
  }
  policy(id: Types.ObjectId, session: ClientSession) { return RolePolicyModel.findById(id).session(session).lean(); }
  async createPolicy(input: PolicyInput, actorId: Types.ObjectId, session: ClientSession) {
    const [policy] = await RolePolicyModel.create([{ ...input, createdBy: actorId }], { session });
    if (!policy) throw new Error('Policy insertion failed');
    return policy.toObject();
  }
  updatePolicy(id: Types.ObjectId, revision: number, input: PolicyInput, session: ClientSession) {
    return RolePolicyModel.findOneAndUpdate({ _id: id, revision }, { $set: input, $inc: { revision: 1 } },
      { returnDocument: 'after', runValidators: true, session }).lean();
  }
  async reportingEdgeExists(creatorRoleId: Types.ObjectId, targetRoleId: Types.ObjectId, crossBranchOnly: boolean, session: ClientSession): Promise<boolean> {
    const result = await UserModel.aggregate([
      { $match: { roleId: targetRoleId, isActive: true } },
      { $set: { managerIds: { $setUnion: [{ $ifNull: ['$reportingManagerIds', []] }, { $cond: ['$reportingManagerId', ['$reportingManagerId'], []] }] } } },
      { $lookup: { from: 'users', localField: 'managerIds', foreignField: '_id', as: 'manager' } },
      { $unwind: '$manager' }, { $match: { 'manager.roleId': creatorRoleId } },
      ...(crossBranchOnly ? [{ $match: { $expr: { $ne: ['$branchId', '$manager.branchId'] } } }] : []), { $limit: 1 },
    ]).session(session).option({ maxTimeMS: 3000 }); return result.length > 0;
  }
}
