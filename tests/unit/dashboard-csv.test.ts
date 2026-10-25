import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { dashboardCsv } from '../../src/modules/dashboards/dashboard.csv.js';
import { dashboardWindows } from '../../src/modules/dashboards/dashboard.service.js';
import { dashboardQuerySchema } from '../../src/modules/dashboards/dashboard.validator.js';
import type { DashboardQuery } from '../../src/modules/dashboards/dashboard.types.js';
describe('dashboard CSV and comparison boundaries', () => {
  it('has stable fingerprints, quotes/neutralizes formulas and keeps exact decimal strings', () => {
    const one = dashboardCsv({ z: '9007199254740993.25', a: '=1+1', id: new Types.ObjectId('111111111111111111111111') });
    const two = dashboardCsv({ id: new Types.ObjectId('111111111111111111111111'), a: '=1+1', z: '9007199254740993.25' });
    expect(one.fingerprint).toBe(two.fingerprint); expect(one.body.toString()).toContain("'=1+1"); expect(one.body.toString()).toContain('9007199254740993.25');
    expect(() => dashboardCsv({ rows: Array.from({ length: 50001 }, () => 1) })).toThrow('50000');
  });
  it('compares equal elapsed durations while excluding the future in a partially completed period', () => {
    const parsed = dashboardQuerySchema.validate({ startDate: '2026-10-01', endDate: '2026-11-01' }); const query = parsed.value as DashboardQuery;
    const asOf = new Date('2026-10-17T06:00:00Z'); const windows = dashboardWindows(query, asOf);
    expect(windows.current.start.toISOString()).toBe('2026-09-30T18:30:00.000Z'); expect(windows.current.end.getTime()).toBe(asOf.getTime() + 1);
    expect(windows.previous.end.getTime() - windows.previous.start.getTime()).toBe(windows.current.end.getTime() - windows.current.start.getTime());
  });
});
