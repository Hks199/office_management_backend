import { AppError } from '../../shared/errors/app-error.js';
import type { PeriodType } from './target.types.js';
import { decimalString, hundredths } from '../leads/decimal.js';
const DAY = 86400000; const OFFSET = 330 * 60000;
export const boundary = (day: string): Date => new Date(new Date(`${day}T00:00:00Z`).getTime() - OFFSET);
export function targetPeriod(type: PeriodType, start: string, end: string) {
  const first = new Date(`${start}T00:00:00Z`); const last = new Date(`${end}T00:00:00Z`); const days = (last.getTime() - first.getTime()) / DAY;
  const nextMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
  if (!Number.isInteger(days) || days < 1 || days > 366 || (type === 'DAILY' && days !== 1) ||
    (type === 'WEEKLY' && (days !== 7 || first.getUTCDay() !== 1)) ||
    (type === 'MONTHLY' && (first.getUTCDate() !== 1 || last.getTime() !== nextMonth.getTime()))) {
    throw new AppError(400, 'INVALID_TARGET_PERIOD', 'Use one business day, a Monday week, a calendar month, or a custom interval of 1-366 days; endDate is exclusive');
  }
  return { startDate: boundary(start), endDate: boundary(end) };
}
export function achievement(actual: string, target: string): string {
  const numerator = hundredths(actual); const denominator = hundredths(target);
  return denominator > 0n ? decimalString((numerator * 10000n + denominator / 2n) / denominator) : '0.00';
}
