import Joi from 'joi';
import { Types, trusted, type PipelineStage, type InferSchemaType } from 'mongoose';
import type { Principal } from '../auth/auth.types.js';
import { LeadModel } from '../leads/commercial.models.js';
import { CommercialAccess, leadAdapter } from '../leads/commercial-access.js';
import { BranchModel } from '../branches/branch.model.js';
import { UserModel } from '../users/user.model.js';
import { literalPrefix } from '../../shared/utils/query.js';
import { AppError } from '../../shared/errors/app-error.js';
import { ConfirmedCustomerModel } from './customer.model.js';

export const salesCustomerQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).max(10000).default(1), limit: Joi.number().integer().min(1).max(100).default(20),
  sortOrder: Joi.string().valid('asc', 'desc').default('desc'),
  search: Joi.string().trim().min(2).max(150), status: Joi.string().valid('CONFIRMED', 'REVIEW_REQUIRED'),
});
export interface SalesCustomerQuery { page: number; limit: number; sortOrder: 'asc' | 'desc'; search?: string; status?: string }
type CustomerRow = InferSchemaType<typeof ConfirmedCustomerModel.schema> & { _id: Types.ObjectId; branchId: Types.ObjectId; assignedTo: Types.ObjectId | null; leadCode: string; leadStatus: string };

export class SalesCustomerService {
  private readonly access = new CommercialAccess();
  private async pipeline(actor: Principal): Promise<PipelineStage[]> {
    // Start from live lead authorization before joining customer snapshots. Reassignments,
    // hierarchy changes and revoked permissions immediately affect customer visibility.
    return [
      { $match: await this.access.scopes.predicate(actor, 'leads:read', leadAdapter) },
      { $lookup: { from: 'confirmed_customers', localField: '_id', foreignField: 'leadId', as: 'customer' } },
      { $unwind: '$customer' },
      { $replaceRoot: { newRoot: { $mergeObjects: ['$customer', { branchId: '$branchId', assignedTo: '$assignedTo', leadCode: '$leadCode', leadStatus: '$status' }] } } },
      { $project: { contactId: 0 } },
    ];
  }
  private async labels(rows: CustomerRow[]) {
    if (!rows.length) return [];
    const ids = (values: (Types.ObjectId | null)[]) => [...new Set(values.filter((id): id is Types.ObjectId => Boolean(id)).map((id) => id.toHexString()))].map((id) => new Types.ObjectId(id));
    const [users, branches] = await Promise.all([
      UserModel.find({ _id: trusted({ $in: ids(rows.flatMap((row) => [row.assignedTo, row.confirmedBy])) }) }).select('_id firstName lastName employeeCode').lean(),
      BranchModel.find({ _id: trusted({ $in: ids(rows.map((row) => row.branchId)) }) }).select('_id branchName branchCode').lean(),
    ]);
    const people = new Map(users.map((person) => [person._id.toHexString(), person]));
    const offices = new Map(branches.map((branch) => [branch._id.toHexString(), branch]));
    return rows.map((row) => {
      const assignee = row.assignedTo ? people.get(row.assignedTo.toHexString()) : undefined;
      const confirmer = people.get(row.confirmedBy.toHexString()); const branch = offices.get(row.branchId.toHexString());
      return { ...row, requiredCapacityKw: row.requiredCapacityKw.toString(), ratePerKw: row.ratePerKw.toString(), projectValue: row.projectValue.toString(),
        assignedToName: assignee ? `${assignee.firstName} ${assignee.lastName}`.trim() : null, assignedToCode: assignee?.employeeCode ?? null,
        confirmedByName: confirmer ? `${confirmer.firstName} ${confirmer.lastName}`.trim() : null, confirmedByCode: confirmer?.employeeCode ?? null,
        branchName: branch?.branchName ?? null, branchCode: branch?.branchCode ?? null };
    });
  }
  async list(actor: Principal, query: SalesCustomerQuery) {
    const filters = { ...(query.status ? { status: query.status } : {}), ...(query.search ? { $or: ['name', 'mobileNumber', 'customerCode', 'leadCode'].map((field) => ({ [field]: literalPrefix(query.search ?? '') })) } : {}) };
    const result = await LeadModel.aggregate<{ data: CustomerRow[]; total: { count: number }[] }>([
      ...await this.pipeline(actor), { $match: filters },
      { $facet: { data: [{ $sort: { confirmedAt: query.sortOrder === 'asc' ? 1 : -1, _id: 1 } }, { $skip: (query.page - 1) * query.limit }, { $limit: query.limit }], total: [{ $count: 'count' }] } },
    ]).option({ maxTimeMS: 5000 });
    return { data: await this.labels(result[0]?.data ?? []), total: result[0]?.total[0]?.count ?? 0 };
  }
  async get(actor: Principal, id: Types.ObjectId) {
    const rows = await LeadModel.aggregate<CustomerRow>([...await this.pipeline(actor), { $match: { _id: id } }, { $limit: 1 }]).option({ maxTimeMS: 5000 });
    const record = (await this.labels(rows))[0];
    if (!record) throw new AppError(404, 'NOT_FOUND', 'Customer not found'); return record;
  }
}
