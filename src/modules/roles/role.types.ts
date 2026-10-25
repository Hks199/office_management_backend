import type { DataScope } from '../../constants/permissions.js';
export interface GrantInput { permissionId: string; scope: DataScope }
export interface RoleCreate { name: string; code: string; description?: string; permissions: GrantInput[]; allowsNoBranch?: boolean }
export interface RoleUpdate { revision: number; name?: string; description?: string; permissions?: GrantInput[]; isActive?: boolean; allowsNoBranch?: boolean }
export interface PolicyInput {
  creatorRoleId: string; targetRoleId: string; allowedManagerRoleIds: string[];
  branchRule: 'SAME_BRANCH' | 'EXPLICIT_SCOPE'; allowCrossBranchReporting: boolean; isActive: boolean;
  creatorRoleRevision?: number; targetRoleRevision?: number;
}
export interface RoleQuery { page: number; limit: number; sortBy: 'name' | 'createdAt'; sortOrder: 'asc' | 'desc'; search?: string; isActive?: boolean }
export interface PolicyQuery { page: number; limit: number; sortOrder: 'asc' | 'desc'; isActive?: boolean; creatorRoleId?: string; targetRoleId?: string }
