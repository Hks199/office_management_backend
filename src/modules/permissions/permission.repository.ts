import { Types, trusted, type ClientSession } from 'mongoose';
import { RoleModel } from '../roles/role.model.js';
import { PermissionModel } from './permission.model.js';

export class PermissionRepository {
  role(id: Types.ObjectId, session?: ClientSession) {
    return RoleModel.findOne({ _id: id, isActive: true }).session(session ?? null).lean();
  }
  definitions(ids: Types.ObjectId[], session?: ClientSession) {
    return PermissionModel.find({ _id: trusted({ $in: ids }) }).session(session ?? null).lean();
  }
}
