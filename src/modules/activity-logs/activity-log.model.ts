import { Schema, model } from 'mongoose';
import { AppError } from '../../shared/errors/app-error.js';

const schema = new Schema({
  actorId: { type: Schema.Types.ObjectId, default: null }, action: { type: String, required: true },
  entityType: { type: String, required: true }, entityId: { type: Schema.Types.ObjectId, default: null },
  timestamp: { type: Date, default: Date.now, required: true }, requestId: { type: String, required: true },
  metadata: { type: Map, of: String, default: {} },
}, { strict: 'throw', collection: 'activity_logs' });
schema.index({ actorId: 1, timestamp: -1, _id: -1 });
schema.index({ entityType: 1, entityId: 1, timestamp: -1 });
schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'], () => {
  throw new AppError(403, 'AUDIT_IMMUTABLE', 'Audit events are append-only');
});
schema.pre('bulkWrite', () => { throw new AppError(403, 'AUDIT_IMMUTABLE', 'Audit events are append-only'); });
export const ActivityLogModel = model('ActivityLog', schema);
