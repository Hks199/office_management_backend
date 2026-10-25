import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { LocationService } from './location.service.js';
import type { LocationKind } from './location.model.js';
import type { LocationInput, LocationQuery, LocationUpdate } from './location.types.js';
import { principalFrom, bodyFrom } from '../auth/auth.controller.js';
import { sendSuccess } from '../../shared/utils/response.js';
import { pageMeta } from '../../shared/utils/query.js';
export class LocationController {
  constructor(private readonly kind: LocationKind, private readonly service = new LocationService()) {}
  list = async (_req: Request, res: Response): Promise<void> => {
    const query = res.locals.validated?.query as LocationQuery; const result = await this.service.list(principalFrom(res), this.kind, query);
    sendSuccess(res, result.data, 'Locations retrieved', 200, pageMeta(query, result.total));
  };
  create = async (_req: Request, res: Response): Promise<void> => {
    sendSuccess(res, await this.service.create(principalFrom(res), this.kind, bodyFrom<LocationInput>(res), res.locals), 'Location created', 201);
  };
  update = async (_req: Request, res: Response): Promise<void> => {
    const id = new Types.ObjectId((res.locals.validated?.params as { id: string }).id);
    sendSuccess(res, await this.service.update(principalFrom(res), this.kind, id, bodyFrom<LocationUpdate>(res), res.locals), 'Location updated');
  };
}
