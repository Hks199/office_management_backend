import mongoose, { type ClientSession } from 'mongoose';
import type { Principal } from '../../modules/auth/auth.types.js';
import { AuthRepository } from '../../modules/auth/auth.repository.js';
import { SecurityStateModel } from '../../modules/auth/auth.models.js';
import { AuthorizationService } from '../../modules/permissions/authorization.service.js';
import type { PermissionCode } from '../../constants/permissions.js';
import { AppError } from '../errors/app-error.js';

export class OrganizationAccess {
  private readonly auth = new AuthRepository();
  private readonly authorization = new AuthorizationService();
  transaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> { return mongoose.connection.transaction(work); }
  async actor(principal: Principal, action: PermissionCode, session: ClientSession): Promise<Principal> {
    // Same first lock as role/policy mutations; organization edits see a coherent policy/graph snapshot.
    await SecurityStateModel.updateOne({ _id: 'administration' }, { $inc: { revision: 1 } }, { upsert: true, session });
    await SecurityStateModel.updateOne({ _id: 'hierarchy' }, { $inc: { revision: 1 } }, { upsert: true, session });
    const user = await this.auth.lockUser(principal.userId, session);
    if (!user || user.authVersion !== principal.authVersion || !(await this.auth.activeSession(principal.sessionId, user._id, session))) {
      throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
    }
    const grants = await this.authorization.grants(user.roleId, session);
    if (!grants) throw new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
    const actor = { ...principal, roleId: user.roleId, branchId: user.branchId ?? null, grants };
    this.authorization.require(actor, action);
    return actor;
  }
}
