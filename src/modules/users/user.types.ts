import { managerIds } from './reporting-managers.js';
import type { Types } from 'mongoose';
import type { User } from './user.model.js';
import type { PageQuery } from '../../shared/utils/query.js';
export type EmployeeRecord = User & { _id: Types.ObjectId };
export interface EmployeeCreate {
  employeeCode: string; firstName: string; lastName: string; email: string; mobileNumber: string;
  roleId: string; branchId: string | null; reportingManagerId?: string; reportingManagerIds?: string[]; dateOfJoining: string; designation?: string; department?: string;
}
export interface EmployeeUpdate { revision: number; firstName?: string; lastName?: string; email?: string; mobileNumber?: string; designation?: string; department?: string; dateOfJoining?: string }
export interface EmployeeQuery extends PageQuery {
  sortBy: 'employeeCode' | 'firstName' | 'createdAt' | 'dateOfJoining'; search?: string; branchId?: string; managerId?: string;
  roleId?: string; isActive?: boolean; employmentStatus?: 'ACTIVE' | 'ON_LEAVE' | 'EXITED'; department?: string; startDate?: string; endDate?: string;
}
export interface HierarchyQuery extends EmployeeQuery { rootId?: string; depth: number }
export const EMPLOYEE_PUBLIC_FIELDS = '_id employeeCode firstName lastName email mobileNumber roleId branchId reportingManagerId reportingManagerIds designation department dateOfJoining employmentStatus isActive createdAt updatedAt revision';
export function employeeDto(user: EmployeeRecord) {
  return { _id: user._id, employeeCode: user.employeeCode, firstName: user.firstName, lastName: user.lastName,
    email: user.email, mobileNumber: user.mobileNumber, roleId: user.roleId, branchId: user.branchId,
    reportingManagerId: user.reportingManagerId, reportingManagerIds: managerIds(user), designation: user.designation, department: user.department,
    dateOfJoining: user.dateOfJoining, employmentStatus: user.employmentStatus, isActive: user.isActive,
    revision: user.revision, createdAt: user.createdAt, updatedAt: user.updatedAt };
}
