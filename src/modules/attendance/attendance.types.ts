import type { LocationEvidence } from './attendance-policy.js';
export interface AttendanceEvidence { photoFileId: string; capturedAt: string; location: LocationEvidence }
export interface AttendanceQuery { month: string; from?: string; to?: string; managerId?: string; roleId?: string; outsideGeofence?: boolean; employeeId?: string; branchId?: string; status?: 'OPEN' | 'COMPLETED';
  reviewStatus?: 'PENDING' | 'APPROVED' | 'REJECTED'; lateArrival?: boolean; earlyExit?: boolean; page: number; limit: number; sortOrder: 'asc' | 'desc' }
export interface ReviewInput { revision: number; reviewStatus: 'PENDING' | 'APPROVED' | 'REJECTED'; reason: string }
export interface CorrectionInput { revision: number; effectiveCheckInAt: string; effectiveCheckOutAt: string | null; reason: string }
