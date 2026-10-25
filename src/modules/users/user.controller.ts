import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import type { UserService } from './user.service.js';
import type { EmployeeCreate, EmployeeQuery, EmployeeUpdate, HierarchyQuery } from './user.types.js';
import { principalFrom, bodyFrom } from '../auth/auth.controller.js';
import { sendSuccess } from '../../shared/utils/response.js';
import { pageMeta } from '../../shared/utils/query.js';
const idFrom = (res: Response) => new Types.ObjectId((res.locals.validated?.params as { id: string }).id);
export class UserController {
  constructor(private readonly service: UserService) {}
  managerOptions = async (_req: Request, res: Response): Promise<void> => {
    const query = res.locals.validated?.query as { roleId: string; page: number; limit: number; sortOrder: 'asc' | 'desc'; search?: string };
    const result = await this.service.managerOptions(principalFrom(res), query);
    sendSuccess(res, result.data, 'Approved reporting managers retrieved', 200, pageMeta(query, result.total));
  };
  branchOptions = async (_req: Request, res: Response): Promise<void> => {
    const query = res.locals.validated?.query as { roleId: string; page: number; limit: number; sortOrder: 'asc' | 'desc'; search?: string };
    const result = await this.service.branchOptions(principalFrom(res), query);
    sendSuccess(res, result.data, 'Approved branches retrieved', 200, pageMeta(query, result.total));
  };
  roleOptions(action: 'users:create' | 'roles:assign') { return async (_req: Request, res: Response): Promise<void> => {
    const query = res.locals.validated?.query as { page: number; limit: number; sortOrder: 'asc' | 'desc'; search?: string };
    const result = await this.service.roleOptions(principalFrom(res), action, query);
    sendSuccess(res, result.data, 'Approved roles retrieved', 200,
      { ...pageMeta(query, result.total), policyReviewRequired: result.policyReviewRequired });
  }; }
  list = async (_req: Request, res: Response): Promise<void> => {
    const query = res.locals.validated?.query as EmployeeQuery; const result = await this.service.list(principalFrom(res), query);
    sendSuccess(res, result.data, 'Employees retrieved', 200, pageMeta(query, result.total));
  };
  tree(includeRoot: boolean) { return async (_req: Request, res: Response): Promise<void> => {
    const query = res.locals.validated?.query as HierarchyQuery; const result = await this.service.tree(principalFrom(res), query, includeRoot);
    sendSuccess(res, result.data, 'Reporting hierarchy retrieved', 200, pageMeta(query, result.total));
  }; }
  get = async (_req: Request, res: Response): Promise<void> => { sendSuccess(res, await this.service.get(principalFrom(res), idFrom(res))); };
  create = async (_req: Request, res: Response): Promise<void> => { sendSuccess(res, await this.service.create(principalFrom(res), bodyFrom<EmployeeCreate>(res), res.locals), 'Employee created', 201); };
  update = async (_req: Request, res: Response): Promise<void> => { sendSuccess(res, await this.service.update(principalFrom(res), idFrom(res), bodyFrom<EmployeeUpdate>(res), res.locals), 'Employee updated'); };
  manager = async (_req: Request, res: Response): Promise<void> => {
    const body = bodyFrom<{ revision: number; reportingManagerId?: string; reportingManagerIds?: string[]; reason: string }>(res);
    sendSuccess(res, await this.service.manager(principalFrom(res), idFrom(res), body.revision, body.reportingManagerIds ?? body.reportingManagerId ?? [], body.reason, res.locals), 'Manager updated');
  };
  transfer = async (_req: Request, res: Response): Promise<void> => {
    const body = bodyFrom<{ revision: number; branchId: string | null; reportingManagerId?: string; reportingManagerIds?: string[]; reason: string }>(res);
    sendSuccess(res, await this.service.transfer(principalFrom(res), idFrom(res), body.revision, body.branchId, body.reportingManagerIds ?? body.reportingManagerId ?? [], body.reason, res.locals), 'Employee transferred');
  };
  status = async (_req: Request, res: Response): Promise<void> => {
    const body = bodyFrom<{ revision: number; isActive: boolean; employmentStatus: 'ACTIVE' | 'ON_LEAVE' | 'EXITED'; reason: string }>(res);
    sendSuccess(res, await this.service.status(principalFrom(res), idFrom(res), body.revision, body.isActive, body.employmentStatus, body.reason, res.locals), 'Employee status updated');
  };
  role = async (_req: Request, res: Response): Promise<void> => {
    const body = bodyFrom<{ revision: number; roleId: string; reason: string }>(res);
    sendSuccess(res, await this.service.role(principalFrom(res), idFrom(res), body.revision, body.roleId, body.reason, res.locals), 'Employee role updated');
  };
}
