import type { PageQuery } from '../../shared/utils/query.js';
import type { AttendancePolicy } from '../attendance/attendance-policy.js';
import type { LocationChain } from '../locations/location.types.js';
export interface BranchInput extends LocationChain { branchCode: string; branchName: string; address: string; contactNumber: string; attendancePolicy?: AttendancePolicy }
export interface BranchUpdate { revision: number; branchName?: string; address?: string; contactNumber?: string; stateId?: string; districtId?: string; blockId?: string | null; isActive?: boolean; attendancePolicy?: AttendancePolicy }
export interface BranchQuery extends PageQuery { sortBy: 'branchName' | 'branchCode' | 'createdAt'; search?: string; isActive?: boolean; stateId?: string; districtId?: string; blockId?: string }
