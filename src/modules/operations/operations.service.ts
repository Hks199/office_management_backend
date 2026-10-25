import type { Principal } from '../auth/auth.types.js';
import { OrganizationAccess } from '../../shared/services/organization-access.js';
import { AuthorizationService } from '../permissions/authorization.service.js';
import { OperationsRepository } from './operations.repository.js';
import { databaseTelemetry, type HttpTelemetry } from './telemetry.js';

export class OperationsService {
  constructor(private readonly telemetry: HttpTelemetry, private readonly repository = new OperationsRepository(),
    private readonly access = new OrganizationAccess()) {}

  private guard(principal: Principal): Promise<void> {
    return this.access.transaction(async (session) => {
      const actor = await this.access.actor(principal, 'settings:manage', session);
      new AuthorizationService().requireAll(actor, 'settings:manage');
    });
  }
  async snapshot(principal: Principal) {
    await this.guard(principal);
    // Observations need no cross-queue snapshot. Keep scans outside global write fences.
    const queues = await this.repository.queues();
    await this.guard(principal); // Check publication after a possible permission/session change.
    return { observedAt: new Date(), http: this.telemetry.snapshot(),
      database: { scope: 'PROCESS_OBSERVED_EVENTS', ...databaseTelemetry }, queues };
  }
}
