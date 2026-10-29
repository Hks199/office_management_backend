import { afterEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import { attendanceEligibility, type OfficeSchedule } from '../../src/modules/attendance/workforce-rules.js';
import { officeSettingsSchema, attendanceQuerySchema } from '../../src/modules/attendance/attendance.validator.js';
import { isManagingDirector, requireManagingDirector } from '../../src/shared/services/md-access.js';
import { WorkforceService } from '../../src/modules/attendance/workforce.service.js';
import { UserModel } from '../../src/modules/users/user.model.js';
import { RoleModel } from '../../src/modules/roles/role.model.js';
import { PermissionModel } from '../../src/modules/permissions/permission.model.js';
import { BranchModel } from '../../src/modules/branches/branch.model.js';
import { AttendanceCalendarModel } from '../../src/modules/dashboards/dashboard.model.js';
import { AttendanceModel } from '../../src/modules/attendance/attendance.model.js';
import { OfficeSettingsModel } from '../../src/modules/attendance/office-settings.model.js';
import { ScopeService } from '../../src/modules/permissions/authorization.service.js';
import type { AttendanceQuery } from '../../src/modules/attendance/attendance.types.js';
import type { Principal } from '../../src/modules/auth/auth.types.js';
const office: OfficeSchedule = { startMinute: 540, endMinute: 1080, graceMinutes: 15, workingWeekdays: [1, 2, 3, 4, 5], holidays: [] };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('daily absence eligibility', () => {
  it('does not mark employees absent before start plus grace', () => {
    expect(attendanceEligibility('2026-10-29', office, false, new Date('2026-10-29T09:14:59+05:30'))).toBe('NOT_DUE');
    expect(attendanceEligibility('2026-10-29', office, false, new Date('2026-10-29T09:15:00+05:30'))).toBe('ABSENT');
  });
  it('excludes holidays and weekly offs', () => {
    const now = new Date('2026-10-29T16:00:00+05:30');
    expect(attendanceEligibility('2026-10-29', { ...office, holidays: ['2026-10-29'] }, false, now)).toBe('NON_WORKING_DAY');
    expect(attendanceEligibility('2026-11-01', office, false, now)).toBe('NON_WORKING_DAY');
  });
  it('reports real check-ins without requiring a configured schedule', () => {
    expect(attendanceEligibility('2026-10-29', null, true, new Date())).toBe('PRESENT');
    expect(attendanceEligibility('2026-10-29', null, false, new Date())).toBe('NOT_CONFIGURED');
  });
  it.each([
    { ...office, revision: 0, endMinute: 500 },
    { ...office, revision: 0, workingWeekdays: [] },
    { ...office, revision: 0, workingWeekdays: [1, 1] },
    { ...office, revision: 0, holidays: ['2026-02-30'] },
  ])('rejects invalid office schedule %j', (input) => {
    expect(officeSettingsSchema.validate(input).error).toBeDefined();
  });
});
describe('MD-only settings authority', () => {
  it('checks active system MD identity rather than broad management grants', async () => {
    const exists = vi.spyOn(RoleModel, 'exists').mockReturnValue({ session: vi.fn().mockResolvedValue(null) } as never);
    const actor = { roleId: new Types.ObjectId(), grants: [{ permission: 'settings:manage', scope: 'ALL' }] } as Principal;
    await expect(requireManagingDirector(actor)).rejects.toMatchObject({ statusCode: 403, code: 'MD_ONLY' });
    expect(exists).toHaveBeenCalledWith({ _id: actor.roleId, code: 'MD', isSystemRole: true, isActive: true });
  });
  it('disallows settings through an employee panel, including MD identity', async () => {
    const exists = vi.spyOn(RoleModel, 'exists');
    const actor = { employeePanel: {} } as Principal;
    await expect(isManagingDirector(actor)).resolves.toBe(false);
    await expect(requireManagingDirector(actor)).rejects.toMatchObject({ code: 'MD_ONLY' });
    expect(exists).not.toHaveBeenCalled();
  });
  it('allows a verified MD identity', async () => {
    vi.spyOn(RoleModel, 'exists').mockReturnValue({ session: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }) } as never);
    await expect(requireManagingDirector({ roleId: new Types.ObjectId() } as Principal)).resolves.toBeUndefined();
  });
});
it('counts scoped employees, excluding leave, exited and future joining dates from absence', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-29T11:00:00+05:30'));
  const role = new Types.ObjectId(); const ids = Array.from({ length: 6 }, () => new Types.ObjectId());
  const employees = ids.map((_id, index) => ({ _id, roleId: role, branchId: null, isActive: index !== 4,
    employmentStatus: index === 3 ? 'ON_LEAVE' : index === 4 ? 'EXITED' : 'ACTIVE',
    dateOfJoining: new Date(index === 5 ? '2026-11-01' : '2026-01-01') }));
  const chain = { select: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), maxTimeMS: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue(employees) };
  const find = vi.spyOn(UserModel, 'find').mockReturnValue(chain as never);
  const accessScope = { _id: ids[0] };
  vi.spyOn(ScopeService.prototype, 'predicate').mockResolvedValue(accessScope);
  vi.spyOn(PermissionModel, 'findOne').mockReturnValue({ select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue({ _id: new Types.ObjectId() }) }) } as never);
  vi.spyOn(OfficeSettingsModel, 'findById').mockReturnValue({ lean: vi.fn().mockResolvedValue(office) } as never);
  vi.spyOn(BranchModel, 'find').mockReturnValue({ select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }) } as never);
  vi.spyOn(AttendanceCalendarModel, 'find').mockReturnValue({ lean: vi.fn().mockResolvedValue([]) } as never);
  vi.spyOn(RoleModel, 'find').mockReturnValue({ select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([{ _id: role }]) }) } as never);
  vi.spyOn(AttendanceModel, 'distinct').mockReturnValue({ maxTimeMS: vi.fn().mockResolvedValue([ids[0]]) } as never);
  const query = attendanceQuerySchema.validate({}).value as AttendanceQuery;
  const result = await new WorkforceService().today({} as Principal, query);
  expect(find).toHaveBeenCalledWith({ $and: [accessScope, {}] });
  expect(result).toMatchObject({ totalEmployees: 6, activeEmployees: 4, onLeave: 1, inactiveEmployees: 1,
    present: 1, absent: 2, notRequired: 1, notConfigured: 0 });
});
