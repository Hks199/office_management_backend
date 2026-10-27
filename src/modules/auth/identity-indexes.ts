import { UserModel } from '../users/user.model.js';
import { RoleModel } from '../roles/role.model.js';
import { PermissionModel } from '../permissions/permission.model.js';
import { RolePolicyModel } from '../roles/role-policy.model.js';
import { RefreshSessionModel, CredentialTokenModel, LoginAttemptModel, SecurityStateModel } from './auth.models.js';
import { ActivityLogModel } from '../activity-logs/activity-log.model.js';
import { CredentialDeliveryModel } from './credential-delivery.model.js';
import { EmployeePanelModel } from './employee-panel.model.js';

export async function createIdentityIndexes(): Promise<void> {
  // Explicit operational migration, never called automatically by HTTP handlers.
  for (const model of [UserModel, RoleModel, PermissionModel, RolePolicyModel, RefreshSessionModel,
    CredentialTokenModel, LoginAttemptModel, SecurityStateModel, ActivityLogModel, CredentialDeliveryModel, EmployeePanelModel]) {
    await model.createCollection();
    await model.createIndexes();
  }
}
