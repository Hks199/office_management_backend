export const TARGET_TYPES = ['CALLS_COMPLETED', 'CONNECTED_CALLS', 'LEADS_GENERATED', 'SITE_VISITS', 'QUALIFIED_LEADS', 'CONVERSIONS', 'SALES_VALUE'] as const;
export const PERIOD_TYPES = ['DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM'] as const;
export type TargetType = typeof TARGET_TYPES[number];
export type PeriodType = typeof PERIOD_TYPES[number];
export interface TargetInput { employeeId: string; targetType: TargetType; targetValue: string; periodType: PeriodType; startDate: string; endDate: string }
export interface TargetUpdate { revision: number; targetValue?: string; startDate?: string; endDate?: string; status?: 'ACTIVE' | 'CANCELLED'; reason: string }
export interface TargetQuery { employeeId?: string; branchId?: string; targetType?: TargetType; periodType?: PeriodType; status: 'ACTIVE' | 'CANCELLED'; from?: string; to?: string; page: number; limit: number; sortOrder: 'asc' | 'desc' }
export interface EvidenceQuery { employeeId?: string; branchId?: string; leadId?: string; milestone?: 'CREATED' | 'QUALIFIED' | 'CONVERTED'; reviewStatus?: 'PENDING' | 'APPROVED' | 'REJECTED'; page: number; limit: number; sortOrder: 'asc' | 'desc' }
export interface EvidenceReview { revision: number; reviewStatus: 'PENDING' | 'APPROVED' | 'REJECTED'; remarks: string }
