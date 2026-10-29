# MD office timings, holidays and workforce counts

The MD can open Attendance > Office timings & holidays to set start/end times,
grace minutes, working weekdays and holiday dates. Only an active system role
with code MD can access this configuration; settings:manage is also required.
Employee panels are excluded. Other roles with ALL management grants cannot
bypass this role check. Existing branch policy writes (including branch creation
with an explicit attendancePolicy) and branch calendar GET/PUT are restricted too.
All schedule mutations use existing revision checks and transactional audit events.

GET /api/v1/attendance/workforce returns current employee counts within the actor's
attendance scope and selected employee/branch/manager/role filters. It is always
for today's Asia/Kolkata date. Historical date/status filters do not change it.
All employees within scope contribute to totalEmployees. Current ACTIVE employees
contribute to activeEmployees; ON_LEAVE and inactive/EXITED counts are separate.
Only active roles with attendance:create SELF are eligible for absence. Future
joining dates and inactive branches are excluded. Check-ins are counted even if
no schedule exists or the day is a holiday, but no absence is inferred without
a complete schedule. Today before start plus grace is notDue. Weekly offs and
holidays are nonWorkingDay; missing calendars/timings are notConfigured.
Absence counts may be partial when notConfigured is nonzero.

Office defaults are stored in attendance_office_settings as the singleton office.
Existing branch timing and working-day settings override office defaults; office
holidays apply everywhere, in addition to branch holidays. Employees without a
branch can use office defaults. Check-in saves the effective timing policy as an
immutable attendance snapshot; existing snapshots are not rewritten by settings.
No real office hours or holidays are guessed/saved automatically.

These counts are provisional during the day and are not approved absence or
payroll. Leave exclusion uses the current ON_LEAVE employment status; this project
has no dated approved-leave ledger. Historical absence cannot be reconstructed
accurately from current employment, branch, calendar and leave states.

## Deployment

1. Deploy the backend code with the additive production collection/index migration.
   The existing EC2 workflow supports RUN_INDEX_MIGRATION=true. Alternatively run
   npm run db:indexes:production with the production migration DB identity before
   production preflight. For local attendance-only setup, npm run
   db:indexes:attendance also initializes the new collection. Existing data is retained.
2. Deploy the frontend and sign in again to get canManageAttendanceSettings in
   /auth/me. It is a UI hint; backend enforcement never trusts client flags.
3. Sign in as MD, open Attendance > Office timings & holidays, enter the actual
   schedule and working days, add holidays, and save. Optionally configure branch
   overrides under Branches > View branch > Attendance settings.
4. Verify today workforce counts with ordinary employees/managers and confirm
   only MD can access global and branch schedule/calendar editing endpoints.

Regression checks:
- npx vitest run tests/unit/workforce-attendance.test.ts tests/unit/attendance-filters.test.ts tests/unit/attendance-policy.test.ts
- npx vitest run tests/integration/attendance.test.ts tests/integration/dashboards.test.ts
Integration checks use isolated MongoDB memory replica sets, not real employee data.
