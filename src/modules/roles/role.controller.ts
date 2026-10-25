import { Types } from 'mongoose';
import type { Request, Response } from 'express';
import { principalFrom, bodyFrom } from '../auth/auth.controller.js';
import { sendSuccess } from '../../shared/utils/response.js';
import type { RoleService } from './role.service.js';
import type { PolicyInput, PolicyQuery, RoleCreate, RoleQuery, RoleUpdate } from './role.types.js';

const idFrom = (res: Response) => new Types.ObjectId((res.locals.validated?.params as { id: string }).id);
const queryFrom = (res: Response) => res.locals.validated?.query as RoleQuery;

export class RoleController {
  constructor(private readonly service: RoleService) {}
  list = async (_req: Request, res: Response): Promise<void> => {
    const query = queryFrom(res); const result = await this.service.list(principalFrom(res), query);
    sendSuccess(res, result.data, 'Roles retrieved', 200, { page: query.page, limit: query.limit,
      total: result.total, totalPages: Math.ceil(result.total / query.limit) });
  };
  get = async (_req: Request, res: Response): Promise<void> => { sendSuccess(res, await this.service.get(principalFrom(res), idFrom(res))); };
  permissions = async (_req: Request, res: Response): Promise<void> => { sendSuccess(res, await this.service.permissions(principalFrom(res))); };
  create = async (_req: Request, res: Response): Promise<void> => {
    sendSuccess(res, await this.service.create(principalFrom(res), bodyFrom<RoleCreate>(res), res.locals), 'Role created', 201);
  };
  update = async (_req: Request, res: Response): Promise<void> => {
    sendSuccess(res, await this.service.update(principalFrom(res), idFrom(res), bodyFrom<RoleUpdate>(res), res.locals), 'Role updated');
  };
  archive = async (_req: Request, res: Response): Promise<void> => {
    sendSuccess(res, await this.service.archive(principalFrom(res), idFrom(res), bodyFrom<{ revision: number }>(res).revision, res.locals), 'Role archived');
  };
  policies = async (_req: Request, res: Response): Promise<void> => {
    const query = res.locals.validated?.query as PolicyQuery;
    const result = await this.service.policies(principalFrom(res), query);
    sendSuccess(res, result.data, 'Policies retrieved', 200, { page: query.page, limit: query.limit,
      total: result.total, totalPages: Math.ceil(result.total / query.limit) });
  };
  createPolicy = async (_req: Request, res: Response): Promise<void> => {
    sendSuccess(res, await this.service.savePolicy(principalFrom(res), bodyFrom<PolicyInput>(res), res.locals), 'Policy created', 201);
  };
  updatePolicy = async (_req: Request, res: Response): Promise<void> => {
    const { revision, ...input } = bodyFrom<PolicyInput & { revision: number }>(res);
    sendSuccess(res, await this.service.savePolicy(principalFrom(res), input, res.locals, idFrom(res), revision), 'Policy updated');
  };
}
