import Joi from 'joi';
import { Schema } from 'mongoose';

export const attendancePolicySchema = new Schema({
  startMinute: { type: Number, min: 0, max: 1439, default: null },
  endMinute: { type: Number, min: 1, max: 1439, default: null },
  graceMinutes: { type: Number, min: 0, max: 120, default: 0 },
  maxAccuracyMeters: { type: Number, min: 1, max: 10000, default: 100 },
  maxCaptureAgeSeconds: { type: Number, min: 30, max: 900, default: 300 },
  geofence: { type: new Schema({ latitude: { type: Number, required: true, min: -90, max: 90 },
    longitude: { type: Number, required: true, min: -180, max: 180 }, radiusMeters: { type: Number, required: true, min: 10, max: 100000 } }, { _id: false }), default: null },
}, { _id: false });
export const attendancePolicyValidation = Joi.object({
  startMinute: Joi.number().integer().min(0).max(1439).allow(null).default(null),
  endMinute: Joi.number().integer().min(1).max(1439).greater(Joi.ref('startMinute')).allow(null).default(null),
  graceMinutes: Joi.number().integer().min(0).max(120).default(0),
  maxAccuracyMeters: Joi.number().min(1).max(10000).default(100),
  maxCaptureAgeSeconds: Joi.number().integer().min(30).max(900).default(300),
  geofence: Joi.object({ latitude: Joi.number().min(-90).max(90).required(), longitude: Joi.number().min(-180).max(180).required(),
    radiusMeters: Joi.number().min(10).max(100000).required() }).allow(null).default(null),
}).custom((value: AttendancePolicy, helpers) => (value.startMinute === null) !== (value.endMinute === null) ? helpers.error('any.invalid') : value);
export interface AttendancePolicy { startMinute: number | null; endMinute: number | null; graceMinutes: number;
  maxAccuracyMeters: number; maxCaptureAgeSeconds: number; geofence: { latitude: number; longitude: number; radiusMeters: number } | null }
export const defaultAttendancePolicy: AttendancePolicy = { startMinute: null, endMinute: null, graceMinutes: 0,
  maxAccuracyMeters: 100, maxCaptureAgeSeconds: 300, geofence: null };
export function normalizePolicy(policy?: Partial<AttendancePolicy> | null): AttendancePolicy { return { ...defaultAttendancePolicy, ...policy }; }
export interface LocationEvidence { latitude: number; longitude: number; accuracyMeters?: number }
export function evidenceFlags(location: LocationEvidence, capturedAt: Date, now: Date, policy: AttendancePolicy): string[] {
  const flags: string[] = [];
  const age = (now.getTime() - capturedAt.getTime()) / 1000;
  if (age > policy.maxCaptureAgeSeconds || age < -60) flags.push('CAPTURE_TIME_SKEW');
  if (location.accuracyMeters === undefined) flags.push('ACCURACY_MISSING');
  else if (location.accuracyMeters > policy.maxAccuracyMeters) flags.push('LOW_GPS_ACCURACY');
  if (policy.geofence) {
    const radians = Math.PI / 180; const fence = policy.geofence;
    const a = Math.sin((location.latitude - fence.latitude) * radians / 2) ** 2 +
      Math.cos(location.latitude * radians) * Math.cos(fence.latitude * radians) * Math.sin((location.longitude - fence.longitude) * radians / 2) ** 2;
    const distance = 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, a)));
    if (distance > fence.radiusMeters) flags.push('OUTSIDE_GEOFENCE');
  }
  return flags;
}
export function scheduleFlags(date: string, checkIn: Date, checkOut: Date | null, policy: AttendancePolicy) {
  const midnight = new Date(`${date}T00:00:00+05:30`).getTime();
  return { lateArrival: policy.startMinute !== null && checkIn.getTime() > midnight + (policy.startMinute + policy.graceMinutes) * 60000,
    earlyExit: policy.endMinute !== null && checkOut !== null && checkOut.getTime() < midnight + policy.endMinute * 60000 };
}
