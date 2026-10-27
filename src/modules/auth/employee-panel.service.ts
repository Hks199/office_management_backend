import mongoose, { Types, trusted } from 'mongoose';
import { AuthRepository } from './auth.repository.js';
import { EmployeePanelModel } from './employee-panel.model.js';
import { RefreshSessionModel, SecurityStateModel } from './auth.models.js';
import { employeePanelAccess, panelGrants } from './employee-panel-access.js';
import { randomToken, tokenHash } from '../../shared/utils/crypto.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { Principal } from './auth.types.js';

const forbidden = () => new AppError(403, 'EMPLOYEE_PANEL_FORBIDDEN', 'You can only open an active, non-administrator employee panel within your permitted downline');
export class EmployeePanelService {
  private readonly auth = new AuthRepository();
  async available(manager: Principal, employeeId: Types.ObjectId) {
    return { allowed: !manager.employeePanel && Boolean(await employeePanelAccess(manager.userId, employeeId)) };
  }
  async start(manager: Principal, employeeId: Types.ObjectId, context: AuditContext) {
    if (manager.employeePanel) throw forbidden();
    return mongoose.connection.transaction(async (session) => {
      await SecurityStateModel.updateOne({ _id: 'administration' }, { $inc: { revision: 1 } }, { upsert: true, session });
      await SecurityStateModel.updateOne({ _id: 'hierarchy' }, { $inc: { revision: 1 } }, { upsert: true, session });
      const locked = await this.auth.lockUser(manager.userId, session);
      const source = await this.auth.activeSession(manager.sessionId, manager.userId, session);
      if (!locked || locked.authVersion !== manager.authVersion || !source || source.employeePanelId) throw forbidden();
      const access = await employeePanelAccess(manager.userId, employeeId, session);
      if (!access) throw forbidden();
      const panelId = new Types.ObjectId(); const employeeSessionId = new Types.ObjectId();
      const panelToken = randomToken();
      const expiresAt = new Date(Math.min(Date.now() + 30 * 60000, source.absoluteExpiresAt.getTime()));
      await EmployeePanelModel.create([{ _id: panelId, managerId: manager.userId, managerFamilyId: source.familyId,
        managerAuthVersion: manager.authVersion, employeeId, employeeAuthVersion: access.employee.authVersion,
        employeeSessionId, tokenHash: tokenHash(panelToken), expiresAt }], { session });
      await RefreshSessionModel.create([{ _id: employeeSessionId, userId: employeeId, familyId: `employee-panel:${panelId.toHexString()}`,
        tokenHash: tokenHash(randomToken()), csrfHash: tokenHash(randomToken()), expiresAt, absoluteExpiresAt: expiresAt,
        authVersion: access.employee.authVersion, employeePanelId: panelId }], { session });
      await audit(session, context, 'EMPLOYEE_PANEL_OPENED', manager.userId, 'user', employeeId,
        { employeePanelId: panelId.toHexString(), expiresAt: expiresAt.toISOString() });
      return { panelToken, expiresAt, employeeName: `${access.employee.firstName} ${access.employee.lastName}` };
    });
  }
  async resolve(manager: Principal, panelToken: string): Promise<Principal> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(panelToken) || manager.employeePanel) throw forbidden();
    const source = await this.auth.activeSession(manager.sessionId, manager.userId);
    const panel = await EmployeePanelModel.findOne({ tokenHash: tokenHash(panelToken), managerId: manager.userId,
      revokedAt: null, expiresAt: trusted({ $gt: new Date() }) }).lean();
    if (!source || !panel || panel.managerFamilyId !== source.familyId || panel.managerAuthVersion !== manager.authVersion ||
      !(await this.auth.activeSession(panel.employeeSessionId, panel.employeeId))) {
      throw new AppError(403, 'EMPLOYEE_PANEL_EXPIRED', 'Employee panel access ended. Return to your account and reopen the panel if permitted.');
    }
    const access = await employeePanelAccess(manager.userId, panel.employeeId);
    if (!access) throw forbidden();
    return { userId: panel.employeeId, roleId: access.employee.roleId, branchId: access.employee.branchId ?? null,
      authVersion: access.employee.authVersion, sessionId: panel.employeeSessionId, grants: panelGrants(access.grants),
      employeePanel: { id: panel._id, managerId: manager.userId,
        managerName: `${access.manager.firstName} ${access.manager.lastName}`, expiresAt: panel.expiresAt } };
  }
  async stop(manager: Principal, panelToken: string, context: AuditContext) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(panelToken)) throw forbidden();
    return mongoose.connection.transaction(async (session) => {
      const source = await this.auth.activeSession(manager.sessionId, manager.userId, session);
      if (!source) throw forbidden();
      const panel = await EmployeePanelModel.findOneAndUpdate({ tokenHash: tokenHash(panelToken), managerId: manager.userId,
        managerFamilyId: source.familyId, revokedAt: null }, { $set: { revokedAt: new Date() } }, { session, returnDocument: 'after' }).lean();
      if (!panel) return;
      await RefreshSessionModel.updateOne({ _id: panel.employeeSessionId }, { $set: { revokedAt: new Date() } }, { session });
      await audit(session, context, 'EMPLOYEE_PANEL_CLOSED', manager.userId, 'user', panel.employeeId, { employeePanelId: panel._id.toHexString() });
    });
  }
}
