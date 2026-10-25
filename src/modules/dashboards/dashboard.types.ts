export const DASHBOARD_KINDS = ['overview', 'attendance', 'leads', 'targets', 'employee-performance', 'branch-performance', 'role-performance', 'lead-funnel', 'trends'] as const;
export type DashboardKind = typeof DASHBOARD_KINDS[number];
export interface DashboardQuery {
  startDate: string; endDate: string; branchId?: string; employeeId?: string; managerId?: string; roleId?: string;
  stateId?: string; districtId?: string; blockId?: string; search?: string; leadStatus?: string[]; leadSource?: string; targetType?: string;
  compare: boolean; page: number; limit: number; sortBy: 'approvedCalls' | 'approvedVisits' | 'approvedConversions' | 'salesValue' | 'name'; sortOrder: 'asc' | 'desc';
}
export interface DashboardWindow { start: Date; end: Date }
export interface DashboardPayload { kind: DashboardKind; timezone: 'Asia/Kolkata'; asOf: Date; requestedPeriod: { startDate: string; endDate: string }; data: Record<string, unknown> }
export interface CalendarInput { revision: number; workingWeekdays: number[]; holidays: string[] }
