import { Types, trusted, type ClientSession } from 'mongoose';
import { BranchModel } from './branch.model.js';
import { UserModel } from '../users/user.model.js';
import { literalPrefix } from '../../shared/utils/query.js';
import type { BranchInput, BranchQuery, BranchUpdate } from './branch.types.js';
import type { ScopePredicate } from '../permissions/authorization.service.js';

export class BranchRepository {
  get(id: Types.ObjectId, scope: ScopePredicate = {}, session?: ClientSession) {
    return BranchModel.findOne({ $and: [{ _id: id }, scope] }).session(session ?? null).lean();
  }
  async options(scope: ScopePredicate, query: { page: number; limit: number; sortOrder: 'asc' | 'desc'; search?: string }, session: ClientSession) {
    const filter = { $and: [scope, { isActive: true, ...(query.search ? { $or: [
      { branchName: literalPrefix(query.search) }, { branchCode: literalPrefix(query.search) },
    ] } : {}) }] };
    // Creation lookups expose labels only, without branch contacts or configuration.
    const data = await BranchModel.find(filter).select('_id branchName branchCode').session(session)
      .sort({ branchName: query.sortOrder === 'asc' ? 1 : -1, _id: 1 })
      .skip((query.page - 1) * query.limit).limit(query.limit).lean();
    const total = await BranchModel.countDocuments(filter).session(session);
    return { data, total };
  }
  async list(scope: ScopePredicate, query: BranchQuery) {
    const filter = { $and: [scope, { ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
      ...(query.stateId ? { stateId: new Types.ObjectId(query.stateId) } : {}), ...(query.districtId ? { districtId: new Types.ObjectId(query.districtId) } : {}),
      ...(query.blockId ? { blockId: new Types.ObjectId(query.blockId) } : {}), ...(query.search ? { $or: [
        { branchName: literalPrefix(query.search) }, { branchCode: literalPrefix(query.search) },
      ] } : {}) }] };
    const [data, total] = await Promise.all([BranchModel.find(filter).sort({ [query.sortBy]: query.sortOrder === 'asc' ? 1 : -1, _id: 1 })
      .skip((query.page - 1) * query.limit).limit(query.limit).lean(), BranchModel.countDocuments(filter)]);
    return { data, total };
  }
  async create(input: BranchInput, actorId: Types.ObjectId, session: ClientSession) {
    const [branch] = await BranchModel.create([{ ...input, createdBy: actorId }], { session });
    if (!branch) throw new Error('Branch insertion failed'); return branch.toObject();
  }
  update(id: Types.ObjectId, revision: number, changes: Omit<BranchUpdate, 'revision'> | { branchHeadId: Types.ObjectId | null }, session: ClientSession) {
    return BranchModel.findOneAndUpdate({ _id: id, revision }, { $set: changes, $inc: { revision: 1 } },
      { returnDocument: 'after', runValidators: true, session }).lean();
  }
  async activeEmployees(id: Types.ObjectId, session: ClientSession): Promise<boolean> {
    return Boolean(await UserModel.exists({ branchId: id, isActive: true }).session(session));
  }
  headEmployee(id: Types.ObjectId, session: ClientSession) { return UserModel.findOne({ _id: id, isActive: true }).session(session).lean(); }
  headedBy(id: Types.ObjectId, session: ClientSession) { return BranchModel.findOne({ branchHeadId: id }).session(session).lean(); }
  async headsWithRole(roleId: Types.ObjectId, session: ClientSession): Promise<boolean> {
    const users = await UserModel.find({ roleId }).select('_id').session(session).lean();
    return Boolean(await BranchModel.exists({ branchHeadId: trusted({ $in: users.map((user) => user._id) }) }).session(session));
  }
}
