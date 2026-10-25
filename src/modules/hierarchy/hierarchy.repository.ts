import { Types, trusted, type ClientSession } from 'mongoose';
import { UserModel } from '../users/user.model.js';
import { traverseHierarchy } from './hierarchy-graph.js';

export class HierarchyRepository {
  async branches(ids: Types.ObjectId[], session?: ClientSession): Promise<Types.ObjectId[]> {
    return UserModel.distinct('branchId', { _id: trusted({ $in: ids }), branchId: trusted({ $ne: null }) }).session(session ?? null);
  }
  async directReports(managerId: Types.ObjectId, session?: ClientSession): Promise<Types.ObjectId[]> {
    return (await UserModel.find({ $or: [{ reportingManagerId: managerId }, { reportingManagerIds: managerId }] }).select('_id').session(session ?? null).lean()).map((user) => user._id);
  }
  async descendants(managerId: Types.ObjectId, session?: ClientSession) {
    return traverseHierarchy(managerId, false, session);
  }
  async ancestors(id: Types.ObjectId, session: ClientSession) {
    return traverseHierarchy(id, true, session);
  }
}
