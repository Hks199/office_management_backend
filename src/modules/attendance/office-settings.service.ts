import type { Principal } from '../auth/auth.types.js';
import { OrganizationAccess } from '../../shared/services/organization-access.js';
import { requireManagingDirector } from '../../shared/services/md-access.js';
import { OfficeSettingsModel } from './office-settings.model.js';
import { AppError } from '../../shared/errors/app-error.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
import type { OfficeSchedule } from './workforce-rules.js';
export interface OfficeSettingsInput extends OfficeSchedule { revision: number }
export class OfficeSettingsService {
  private readonly access = new OrganizationAccess();
  async get(actor: Principal) {
    await requireManagingDirector(actor);
    return await OfficeSettingsModel.findById('office').lean() ?? { configured: false, revision: 0 };
  }
  async save(actor: Principal, input: OfficeSettingsInput, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'settings:manage', session);
      await requireManagingDirector(current, session);
      const previous = await OfficeSettingsModel.findById('office').session(session).lean();
      if ((previous?.revision ?? 0) !== input.revision) throw new AppError(409, 'CONFLICT', 'Office settings changed. Reload before saving.');
      const { revision, ...settings } = input;
      const value = await OfficeSettingsModel.findOneAndUpdate({ _id: 'office', ...(previous ? { revision } : {}) },
        { $set: { ...settings, changedBy: current.userId }, $inc: { revision: 1 } },
        { upsert: !previous, session, returnDocument: 'after', runValidators: true }).lean();
      if (!value) throw new AppError(409, 'CONFLICT', 'Office settings changed. Reload before saving.');
      await audit(session, context, 'OFFICE_ATTENDANCE_SETTINGS_UPDATED', current.userId, 'attendance-settings', null,
        { before: JSON.stringify(previous), after: JSON.stringify(value) });
      return value;
    });
  }
}
