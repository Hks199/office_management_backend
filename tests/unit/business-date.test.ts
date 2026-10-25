import { expect, it } from 'vitest';
import { businessDate } from '../../src/shared/utils/business-date.js';

it('uses Kolkata midnight rather than host timezone or UTC date', () => {
  expect(businessDate(new Date('2026-10-17T18:29:59Z'))).toBe('2026-10-17');
  expect(businessDate(new Date('2026-10-17T18:30:00Z'))).toBe('2026-10-18');
  expect(businessDate(new Date('2026-12-31T18:30:00Z'))).toBe('2027-01-01');
});
it('rejects invalid dates', () => {
  expect(() => businessDate(new Date('invalid'))).toThrow(RangeError);
});
