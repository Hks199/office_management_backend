export const DATA_SCOPES = ['SELF', 'DIRECT_REPORTS', 'REPORTING_SUBTREE', 'BRANCH', 'ASSIGNED', 'ALL'] as const;
export type DataScope = typeof DATA_SCOPES[number];

export const PERMISSION_CODES = [
  'users:create', 'users:read', 'users:update', 'users:deactivate', 'users:change_manager', 'users:transfer',
  'hierarchy:read', 'roles:create', 'roles:read', 'roles:update', 'roles:delete', 'roles:assign',
  'permissions:read', 'permissions:assign', 'permissions:delegate_sensitive', 'policies:manage',
  'branches:create', 'branches:read', 'branches:update', 'branches:assign_head',
  'attendance:create', 'attendance:read', 'attendance:review', 'attendance:correct',
  'customers:read', 'customers:assign', 'customers:receive_assignment', 'leads:receive_assignment', 'leads:create', 'leads:read', 'leads:update', 'leads:assign',
  'leads:propose_assignment', 'leads:reopen', 'leads:route', 'leads:import', 'leads:export',
  'imports:create', 'imports:confirm', 'imports:read', 'reports:create', 'reports:read', 'reports:review',
  'targets:create', 'targets:read', 'targets:update', 'dashboard:read', 'dashboard:export',
  'files:upload', 'files:read', 'activity_logs:read', 'locations:read', 'locations:manage', 'settings:manage',
  'notifications:read', 'notifications:update',
] as const;
export type PermissionCode = typeof PERMISSION_CODES[number];
export interface Grant { permission: PermissionCode; scope: DataScope }
export const ADMINISTRATOR_PERMISSIONS: PermissionCode[] = ['roles:create', 'roles:read', 'roles:update', 'roles:delete', 'roles:assign',
  'permissions:read', 'permissions:assign', 'permissions:delegate_sensitive', 'policies:manage', 'users:create', 'users:read', 'users:deactivate'];
export const isAdministrator = (grants: Grant[]) => ADMINISTRATOR_PERMISSIONS.every((code) => grants.some((grant) => grant.permission === code && grant.scope === 'ALL'));

export function permissionDefinition(code: PermissionCode) {
  const sensitive = /^(roles:|permissions:|policies:|settings:)/.test(code);
  const allowedScopes: readonly DataScope[] = code === 'leads:route' ? ['SELF', 'ALL'] : sensitive || code === 'activity_logs:read' ||
    ['locations:manage', 'branches:create', 'branches:assign_head'].includes(code) ? ['ALL'] :
    ['attendance:create', 'reports:create', 'notifications:read', 'notifications:update', 'customers:receive_assignment', 'leads:receive_assignment'].includes(code) ? ['SELF'] :
    code.startsWith('leads:') || code.startsWith('customers:') ? DATA_SCOPES :
    code.startsWith('files:') ? ['SELF', 'ALL'] : ['SELF', 'DIRECT_REPORTS', 'REPORTING_SUBTREE', 'BRANCH', 'ALL'];
  return { code, description: code.replace(':', ' '), resource: code.split(':')[0] ?? code,
    sensitive, allowedScopes: [...allowedScopes], registryVersion: 1 };
}

export function isPermissionCode(value: string): value is PermissionCode {
  return PERMISSION_CODES.some((code) => code === value);
}

export function scopeCovers(held: DataScope, requested: DataScope): boolean {
  return held === 'ALL' || held === requested || (held === 'REPORTING_SUBTREE' && requested === 'DIRECT_REPORTS');
}
