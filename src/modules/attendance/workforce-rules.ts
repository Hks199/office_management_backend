export interface OfficeSchedule { startMinute: number; endMinute: number; graceMinutes: number; workingWeekdays: number[]; holidays: string[] }
export type AttendanceEligibility = 'NOT_CONFIGURED' | 'NON_WORKING_DAY' | 'NOT_DUE' | 'PRESENT' | 'ABSENT';
export function attendanceEligibility(day: string, schedule: OfficeSchedule | null, present: boolean, now: Date): AttendanceEligibility {
  if (present) return 'PRESENT';
  if (!schedule) return 'NOT_CONFIGURED';
  const weekday = new Date(day + 'T00:00:00Z').getUTCDay() || 7;
  if (!schedule.workingWeekdays.includes(weekday) || schedule.holidays.includes(day)) return 'NON_WORKING_DAY';
  const dueAt = Date.parse(day + 'T00:00:00+05:30') + (schedule.startMinute + schedule.graceMinutes) * 60000;
  return now.getTime() < dueAt ? 'NOT_DUE' : 'ABSENT';
}
