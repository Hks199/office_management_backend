import { describe, it, expect } from 'vitest';
import { targetPeriod, achievement } from '../../src/modules/targets/target-period.js';
describe('target business periods and precise achievement', () => {
  it('uses Kolkata midnight, Monday weeks and leap calendar months', () => {
    expect(targetPeriod('DAILY', '2026-10-01', '2026-10-02').startDate.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(targetPeriod('WEEKLY', '2026-10-12', '2026-10-19').endDate.toISOString()).toBe('2026-10-18T18:30:00.000Z');
    expect(targetPeriod('MONTHLY', '2024-02-01', '2024-03-01').endDate.toISOString()).toBe('2024-02-29T18:30:00.000Z');
    expect(() => targetPeriod('MONTHLY', '2024-02-01', '2024-02-29')).toThrow();
    expect(() => targetPeriod('WEEKLY', '2026-10-13', '2026-10-20')).toThrow();
  });
  it('preserves uncapped percentages, zero targets and values beyond floating point precision', () => {
    expect(achievement('3.00', '2.00')).toBe('150.00'); expect(achievement('100', '0')).toBe('0.00');
    expect(achievement('1', '3')).toBe('33.33'); expect(achievement('9007199254740993.25', '9007199254740993.25')).toBe('100.00');
  });
});
