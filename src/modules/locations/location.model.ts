import { Schema, model, type Types } from 'mongoose';
export type LocationKind = 'states' | 'districts' | 'blocks';
export interface LocationRecord {
  _id: Types.ObjectId; code: string; name: string; isActive: boolean; revision: number;
  stateId?: Types.ObjectId; districtId?: Types.ObjectId; kind?: 'BLOCK' | 'TEHSIL';
  sourceVersion?: string; createdBy: Types.ObjectId; createdAt: Date; updatedAt: Date;
}
function schemaFor(kind: LocationKind) {
  const schema = new Schema<LocationRecord>({
    code: { type: String, required: true, uppercase: true, match: /^[A-Z0-9_-]{1,32}$/ },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    isActive: { type: Boolean, default: true, required: true }, revision: { type: Number, default: 0, required: true },
    createdBy: { type: Schema.Types.ObjectId, required: true }, sourceVersion: { type: String, maxlength: 100 },
    ...(kind === 'districts' ? { stateId: { type: Schema.Types.ObjectId, required: true, ref: 'State' } } : {}),
    ...(kind === 'blocks' ? { districtId: { type: Schema.Types.ObjectId, required: true, ref: 'District' },
      kind: { type: String, required: true, enum: ['BLOCK', 'TEHSIL'] } } : {}),
  }, { timestamps: true, strict: 'throw', collection: kind, versionKey: false });
  const parent = kind === 'states' ? {} : kind === 'districts' ? { stateId: 1 as const } : { districtId: 1 as const };
  schema.index({ ...parent, code: 1 }, { unique: true }); schema.index({ ...parent, isActive: 1, name: 1 });
  return schema;
}
export const StateModel = model('State', schemaFor('states'));
export const DistrictModel = model('District', schemaFor('districts'));
export const BlockModel = model('Block', schemaFor('blocks'));
export const locationModels = { states: StateModel, districts: DistrictModel, blocks: BlockModel };
