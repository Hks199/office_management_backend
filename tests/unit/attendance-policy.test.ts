import { expect, it } from 'vitest';
import { defaultAttendancePolicy, evidenceFlags, scheduleFlags } from '../../src/modules/attendance/attendance-policy.js';
it('handles schedule grace boundaries and Kolkata date independent of host timezone', () => {
  const policy = { ...defaultAttendancePolicy, startMinute: 540, endMinute: 1080, graceMinutes: 10 };
  expect(scheduleFlags('2026-10-17', new Date('2026-10-17T03:40:00Z'), new Date('2026-10-17T12:30:00Z'), policy)).toEqual({ lateArrival: false, earlyExit: false });
  expect(scheduleFlags('2026-10-17', new Date('2026-10-17T03:40:00.001Z'), new Date('2026-10-17T12:29:59Z'), policy)).toEqual({ lateArrival: true, earlyExit: true });
  expect(scheduleFlags('2026-10-17', new Date(), null, defaultAttendancePolicy)).toEqual({ lateArrival: false, earlyExit: false });
});
it('flags future timestamps and geofence boundaries while allowing zero coordinate/accuracy', () => {
  const now = new Date('2026-10-17T18:30:00Z');
  const policy = { ...defaultAttendancePolicy, geofence: { latitude: 0, longitude: 0, radiusMeters: 100 } };
  expect(evidenceFlags({ latitude: 0, longitude: 0, accuracyMeters: 0 }, now, now, policy)).toEqual([]);
  expect(evidenceFlags({ latitude: 0, longitude: 0, accuracyMeters: 0 }, new Date(now.getTime() + 61000), now, policy)).toEqual(['CAPTURE_TIME_SKEW']);
});
