import type { Request, Response } from 'express';
import { Types } from 'mongoose';
import { BranchService } from './branch.service.js';
import { principalFrom, bodyFrom } from '../auth/auth.controller.js';
import { sendSuccess } from '../../shared/utils/response.js';
import { pageMeta } from '../../shared/utils/query.js';
import type { BranchInput, BranchQuery, BranchUpdate } from './branch.types.js';
const idFrom = (res: Response) => new Types.ObjectId((res.locals.validated?.params as { id: string }).id);
export class BranchController {
  constructor(private readonly service = new BranchService()) {}
  list = async (_req: Request, res: Response): Promise<void> => {
    const query = res.locals.validated?.query as BranchQuery; const result = await this.service.list(principalFrom(res), query);
    sendSuccess(res, result.data, 'Branches retrieved', 200, pageMeta(query, result.total));
  };
  get = async (_req: Request, res: Response): Promise<void> => { sendSuccess(res, await this.service.get(principalFrom(res), idFrom(res))); };
  create = async (_req: Request, res: Response): Promise<void> => { sendSuccess(res, await this.service.create(principalFrom(res), bodyFrom<BranchInput>(res), res.locals), 'Branch created', 201); };
  update = async (_req: Request, res: Response): Promise<void> => { sendSuccess(res, await this.service.update(principalFrom(res), idFrom(res), bodyFrom<BranchUpdate>(res), res.locals), 'Branch updated'); };
  head = async (_req: Request, res: Response): Promise<void> => {
    const body = bodyFrom<{ revision: number; branchHeadId: string | null; reason: string }>(res);
    sendSuccess(res, await this.service.head(principalFrom(res), idFrom(res), body.revision, body.branchHeadId, body.reason, res.locals), 'Branch head updated');
  };
}
