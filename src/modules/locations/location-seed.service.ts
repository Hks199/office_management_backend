import Joi from 'joi';
import mongoose, { Types } from 'mongoose';
import { locationModels, type LocationKind } from './location.model.js';
import { SecurityStateModel } from '../auth/auth.models.js';
import { UserModel } from '../users/user.model.js';
import { audit } from '../activity-logs/audit.service.js';
import { AppError } from '../../shared/errors/app-error.js';

interface SeedBlock { code: string; name: string; kind: 'BLOCK' | 'TEHSIL' }
interface SeedDistrict { code: string; name: string; blocks: SeedBlock[] }
interface SeedState { code: string; name: string; districts: SeedDistrict[] }
interface LocationSeed { sourceVersion: string; states: SeedState[] }
const base = { code: Joi.string().uppercase().pattern(/^[A-Z0-9_-]{1,32}$/).required(), name: Joi.string().trim().min(1).max(100).required() };
const seedSchema = Joi.object<LocationSeed>({ sourceVersion: Joi.string().min(1).max(100).required(),
  states: Joi.array().min(1).max(100).items(Joi.object({ ...base, districts: Joi.array().max(500).items(Joi.object({ ...base,
    blocks: Joi.array().max(500).items(Joi.object({ ...base, kind: Joi.string().valid('BLOCK', 'TEHSIL').required() })).required(),
  })).required() })).required(),
}).required();

export async function seedLocations(input: unknown): Promise<number> {
  const result = seedSchema.validate(input, { abortEarly: false, allowUnknown: false });
  if (result.error) throw new AppError(400, 'INVALID_LOCATION_SEED', 'Location seed does not match the documented format');
  const seed = result.value;
  const count = seed.states.reduce((total, state) => total + 1 + state.districts.reduce((sum, district) => sum + 1 + district.blocks.length, 0), 0);
  if (count > 500) throw new AppError(400, 'LOCATION_SEED_TOO_LARGE', 'Submit at most 500 locations per seed file');
  return mongoose.connection.transaction(async (session) => {
    await SecurityStateModel.updateOne({ _id: 'administration' }, { $inc: { revision: 1 } }, { upsert: true, session });
    await SecurityStateModel.updateOne({ _id: 'hierarchy' }, { $inc: { revision: 1 } }, { upsert: true, session });
    const root = await UserModel.findOne({ bootstrapKey: 'INITIAL_MD', isActive: true }).session(session).lean();
    if (!root) throw new Error('Bootstrap the initial MD before location seeding');
    const insert = async (kind: LocationKind, data: { code: string; name: string; stateId?: Types.ObjectId; districtId?: Types.ObjectId; kind?: 'BLOCK' | 'TEHSIL' }) => {
      const filter = { code: data.code, ...(data.stateId ? { stateId: data.stateId } : {}), ...(data.districtId ? { districtId: data.districtId } : {}) };
      const record = await locationModels[kind].findOneAndUpdate(filter, { $setOnInsert: { ...data, createdBy: root._id, sourceVersion: seed.sourceVersion } },
        { upsert: true, returnDocument: 'after', session, runValidators: true }).lean();
      if (record.name !== data.name || !record.isActive || (data.kind && record.kind !== data.kind)) {
        throw new AppError(409, 'LOCATION_SEED_CONFLICT', 'Existing location differs; review and update it through the admin API');
      }
      return record._id;
    };
    for (const state of seed.states) {
      const stateId = await insert('states', { code: state.code, name: state.name });
      for (const district of state.districts) {
        const districtId = await insert('districts', { code: district.code, name: district.name, stateId });
        for (const block of district.blocks) await insert('blocks', { ...block, districtId });
      }
    }
    await audit(session, { requestId: 'internal-location-seed' }, 'LOCATIONS_SEEDED', null, 'locations', null,
      { sourceVersion: seed.sourceVersion, submitted: String(count) }); return count;
  });
}
