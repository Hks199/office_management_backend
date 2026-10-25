import { Types, type ClientSession } from 'mongoose';
import { locationModels, type LocationKind } from './location.model.js';
import { BranchModel } from '../branches/branch.model.js';
import { CustomerModel, LeadModel } from '../leads/commercial.models.js';
import { literalPrefix } from '../../shared/utils/query.js';
import type { LocationInput, LocationQuery, LocationUpdate } from './location.types.js';

export class LocationRepository {
  get(kind: LocationKind, id: Types.ObjectId, session?: ClientSession) { return locationModels[kind].findById(id).session(session ?? null).lean(); }
  async list(kind: LocationKind, query: LocationQuery) {
    const filter = { ...(query.stateId ? { stateId: new Types.ObjectId(query.stateId) } : {}),
      ...(query.districtId ? { districtId: new Types.ObjectId(query.districtId) } : {}),
      ...(query.isActive === undefined ? {} : { isActive: query.isActive }), ...(query.search ? { name: literalPrefix(query.search) } : {}) };
    const [data, total] = await Promise.all([locationModels[kind].find(filter).sort({ name: query.sortOrder === 'asc' ? 1 : -1, _id: 1 })
      .skip((query.page - 1) * query.limit).limit(query.limit).lean(), locationModels[kind].countDocuments(filter)]);
    return { data, total };
  }
  async create(kind: LocationKind, input: LocationInput, createdBy: Types.ObjectId, session: ClientSession) {
    const [record] = await locationModels[kind].create([{ ...input, createdBy }], { session });
    if (!record) throw new Error('Location insertion failed'); return record.toObject();
  }
  update(kind: LocationKind, id: Types.ObjectId, input: LocationUpdate, session: ClientSession) {
    const { revision, ...changes } = input;
    return locationModels[kind].findOneAndUpdate({ _id: id, revision }, { $set: changes, $inc: { revision: 1 } },
      { returnDocument: 'after', session, runValidators: true }).lean();
  }
  async referenced(kind: LocationKind, id: Types.ObjectId, session: ClientSession): Promise<boolean> {
    const field = kind === 'states' ? 'stateId' : kind === 'districts' ? 'districtId' : 'blockId';
    if (await BranchModel.exists({ [field]: id }).session(session)) return true;
    if (await CustomerModel.exists({ [field]: id }).session(session) || await LeadModel.exists({ [field]: id }).session(session)) return true;
    if (kind === 'states') return Boolean(await locationModels.districts.exists({ stateId: id, isActive: true }).session(session));
    if (kind === 'districts') return Boolean(await locationModels.blocks.exists({ districtId: id, isActive: true }).session(session));
    return false;
  }
}
