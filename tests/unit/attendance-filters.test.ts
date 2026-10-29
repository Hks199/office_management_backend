import { describe, expect, it, vi } from 'vitest';
import { AttendanceService } from '../../src/modules/attendance/attendance.service.js';
import { ScopeService } from '../../src/modules/permissions/authorization.service.js';
import { UserModel } from '../../src/modules/users/user.model.js';
import type { AttendanceQuery } from '../../src/modules/attendance/attendance.types.js';
import type { Principal } from '../../src/modules/auth/auth.types.js';
import type { FileService } from '../../src/modules/files/file.service.js';
import { Types, trusted } from 'mongoose';
import { attendanceQuerySchema } from '../../src/modules/attendance/attendance.validator.js';
import { AttendanceRepository } from '../../src/modules/attendance/attendance.repository.js';

describe('attendance supervision filters', () => {
  it.each([
    { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-10-29' }, { to: '2026-10-29' },
    { from: '2026-10-30', to: '2026-10-29' },
    { from: '2025-01-01', to: '2026-10-29' },
    { managerId: { $ne: null } }, { roleId: 'invalid' }, { outsideGeofence: 'maybe' },
  ])('rejects malformed or unbounded filters %j', (input) => {
    expect(attendanceQuerySchema.validate(input).error).toBeDefined();
  });
  it('uses inclusive cross-month dates without replacing the access scope', () => {
    const parsed = attendanceQuerySchema.validate({ from: '2026-09-28', to: '2026-10-29',
      status: 'OPEN', lateArrival: 'true', outsideGeofence: 'true' });
    const value = parsed.value as AttendanceQuery;
    expect(parsed.error).toBeUndefined();
    const scope = { employeeId: new Types.ObjectId() };
    const result = new AttendanceRepository().filter(scope, value);
    expect(result.$and).toEqual([scope, expect.objectContaining({
      attendanceDate: { $gte: '2026-09-28', $lte: '2026-10-29' },
      status: 'OPEN', lateArrival: true, evidenceFlags: 'OUTSIDE_GEOFENCE',
    })]);
  });
  it('preserves existing monthly report behavior and false flags', () => {
    const value = attendanceQuerySchema.validate({ month: '2026-12', lateArrival: 'false' }).value as AttendanceQuery;
    expect(new AttendanceRepository().filter({}, value).$and).toEqual([{}, expect.objectContaining({
      attendanceDate: { $gte: '2026-12-01', $lt: '2027-01-01' }, lateArrival: false,
    })]);
  });
});

it('intersects manager and role selections with the actor scope for lists and summaries', async () => {
  const allowedEmployee = new Types.ObjectId();
  const downline = new Types.ObjectId();
  const roleEmployee = new Types.ObjectId();
  const scope = { employeeId: allowedEmployee };
  vi.spyOn(ScopeService.prototype, 'predicate').mockResolvedValue(scope);
  vi.spyOn(ScopeService.prototype, 'descendants').mockResolvedValue([downline]);
  vi.spyOn(UserModel, 'distinct').mockReturnValue({ maxTimeMS: vi.fn().mockResolvedValue([roleEmployee]) } as never);
  const list = vi.spyOn(AttendanceRepository.prototype, 'list').mockResolvedValue({ data: [], total: 0 });
  const summary = vi.spyOn(AttendanceRepository.prototype, 'summary').mockResolvedValue([]);
  const value = attendanceQuerySchema.validate({ managerId: new Types.ObjectId().toHexString(), roleId: new Types.ObjectId().toHexString() }).value as AttendanceQuery;
  const service = new AttendanceService({} as FileService);
  await service.list({} as Principal, value);
  await service.summary({} as Principal, value);
  const expected = { $and: [{ $and: [scope, { employeeId: trusted({ $in: [downline] }) }] }, { employeeId: trusted({ $in: [roleEmployee] }) }] };
  expect(list.mock.calls[0]?.[0]).toEqual(expected);
  expect(summary.mock.calls[0]?.[0]).toEqual(expected);
  vi.restoreAllMocks();
});
