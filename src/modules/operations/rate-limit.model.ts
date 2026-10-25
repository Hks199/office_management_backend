import { Schema, model } from 'mongoose';

const schema = new Schema({
  _id: { type: String, required: true },
  hits: { type: Number, required: true },
  expiresAt: { type: Date, required: true },
}, { collection: 'request_limits', versionKey: false, strict: 'throw' });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const RequestLimitModel = model('RequestLimit', schema);
