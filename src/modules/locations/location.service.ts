import { Types, type ClientSession } from 'mongoose';
import type { Principal } from '../auth/auth.types.js';
import type { LocationKind } from './location.model.js';
import type { LocationChain, LocationInput, LocationQuery, LocationUpdate } from './location.types.js';
import { LocationRepository } from './location.repository.js';
import { OrganizationAccess } from '../../shared/services/organization-access.js';
import { AuthorizationService } from '../permissions/authorization.service.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
import { AppError } from '../../shared/errors/app-error.js';

export class LocationService {
  private readonly access = new OrganizationAccess(); private readonly authorization = new AuthorizationService();
  constructor(private readonly repository = new LocationRepository()) {}
  async assertChain(chain: LocationChain, session: ClientSession): Promise<void> {
    const state = await this.repository.get('states', new Types.ObjectId(chain.stateId), session);
    const district = await this.repository.get('districts', new Types.ObjectId(chain.districtId), session);
    if (!state?.isActive || !district?.isActive || !district.stateId?.equals(state._id)) {
      throw new AppError(400, 'INVALID_LOCATION', 'Select an active state and its district');
    }
    if (chain.blockId) {
      const block = await this.repository.get('blocks', new Types.ObjectId(chain.blockId), session);
      if (!block?.isActive || !block.districtId?.equals(district._id)) throw new AppError(400, 'INVALID_LOCATION', 'Block must belong to the selected district');
    }
  }
  list(actor: Principal, kind: LocationKind, query: LocationQuery) {
    this.authorization.requireAll(actor, 'locations:read'); return this.repository.list(kind, query);
  }
  async create(actor: Principal, kind: LocationKind, input: LocationInput, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'locations:manage', session); this.authorization.requireAll(current, 'locations:manage');
      if (kind !== 'states') {
        const parent = await this.repository.get(kind === 'districts' ? 'states' : 'districts', new Types.ObjectId(input.stateId ?? input.districtId), session);
        if (!parent?.isActive) throw new AppError(400, 'INVALID_LOCATION', 'Parent location must be active');
      }
      const record = await this.repository.create(kind, input, current.userId, session);
      await audit(session, context, 'LOCATION_CREATED', current.userId, kind, record._id, { code: record.code });
      return record;
    });
  }
  async update(actor: Principal, kind: LocationKind, id: Types.ObjectId, input: LocationUpdate, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'locations:manage', session); this.authorization.requireAll(current, 'locations:manage');
      const previous = await this.repository.get(kind, id, session); if (!previous) throw new AppError(404, 'NOT_FOUND', 'Location not found');
      if (input.isActive === false && await this.repository.referenced(kind, id, session)) throw new AppError(409, 'LOCATION_IN_USE', 'Location is still referenced');
      if (input.isActive === true && kind !== 'states') {
        const parentId = kind === 'districts' ? previous.stateId : previous.districtId;
        const parent = parentId ? await this.repository.get(kind === 'districts' ? 'states' : 'districts', parentId, session) : null;
        if (!parent?.isActive) throw new AppError(400, 'INVALID_LOCATION', 'Parent location must be active');
      }
      const record = await this.repository.update(kind, id, input, session);
      if (!record) throw new AppError(409, 'CONFLICT', 'Location changed; reload its revision');
      await audit(session, context, 'LOCATION_UPDATED', current.userId, kind, id,
        { before: JSON.stringify({ name: previous.name, isActive: previous.isActive }), after: JSON.stringify(input) });
      return record;
    });
  }
}
