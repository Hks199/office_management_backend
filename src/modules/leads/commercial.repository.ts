import { Types, trusted, type ClientSession } from 'mongoose';
import { UserModel } from '../users/user.model.js';
import { BranchModel } from '../branches/branch.model.js';
import { LeadModel, CustomerModel } from './commercial.models.js';
import type { CommercialQuery } from './commercial.types.js';
import type { ScopePredicate } from '../permissions/authorization.service.js';
import { literalPrefix } from '../../shared/utils/query.js';
export function commercialFilter(scope: ScopePredicate, query: CommercialQuery): ScopePredicate {
  const filter: ScopePredicate = {};
  for (const field of ['branchId', 'assignedTo', 'createdBy', 'stateId', 'districtId', 'blockId'] as const) if (query[field]) filter[field] = new Types.ObjectId(query[field]);
  if (query.status) filter.status = query.status;
  if (query.leadSource) filter.leadSource = query.leadSource;
  if (query.search) filter.$or = [{ customerName: literalPrefix(query.search) }, { mobileNumber: literalPrefix(query.search) }];
  if (query.startDate || query.endDate) filter.createdAt = trusted({ ...(query.startDate ? { $gte: new Date(query.startDate) } : {}), ...(query.endDate ? { $lt: new Date(query.endDate) } : {}) });
  if (query.followUpFrom || query.followUpTo) filter.nextFollowUpAt = trusted({ ...(query.followUpFrom ? { $gte: new Date(query.followUpFrom) } : {}), ...(query.followUpTo ? { $lt: new Date(query.followUpTo) } : {}) });
  return { $and: [scope, filter, ...(query.assignmentState ? [{ assignedTo: trusted(query.assignmentState === 'UNASSIGNED' ? { $eq: null } : { $ne: null }) }] : [])] };
}
export async function listCommercial(kind: 'customers' | 'leads', scope: ScopePredicate, query: CommercialQuery) {
  const filter = commercialFilter(scope, query); const sort = { createdAt: query.sortOrder === 'asc' ? 1 as const : -1 as const, _id: 1 as const };
  if (kind === 'customers') {
    const [data, total] = await Promise.all([CustomerModel.find(filter).sort(sort).skip((query.page - 1) * query.limit).limit(query.limit).maxTimeMS(5000).lean(), CustomerModel.countDocuments(filter).maxTimeMS(5000)]);
    return { data, total };
  }
  const [rows, total] = await Promise.all([LeadModel.find(filter).sort(sort).skip((query.page - 1) * query.limit).limit(query.limit).maxTimeMS(5000).lean(), LeadModel.countDocuments(filter).maxTimeMS(5000)]);
  return { data: await withLeadLabels(rows.map(leadDto)), total };
}
export function leadDto<T extends { requiredCapacityKw: Types.Decimal128; ratePerKw: Types.Decimal128; estimatedProjectValue: Types.Decimal128; assignedTo?: Types.ObjectId | null }>(lead: T) {
  return { ...lead, assignmentState: lead.assignedTo ? 'ASSIGNED' : 'UNASSIGNED', requiredCapacityKw: lead.requiredCapacityKw.toString(), ratePerKw: lead.ratePerKw.toString(), estimatedProjectValue: lead.estimatedProjectValue.toString() };
}
export async function withLeadLabels<T extends { branchId: Types.ObjectId; assignedTo?: Types.ObjectId | null; assignedBy?: Types.ObjectId | null; createdBy: Types.ObjectId; routedBy?: Types.ObjectId | null; telecallerId?: Types.ObjectId | null }>(rows: T[], session?: ClientSession) {
  if (!rows.length) return [];
  const fields = ['assignedTo', 'assignedBy', 'createdBy', 'routedBy', 'telecallerId'] as const;
  const users = await UserModel.find({ _id: trusted({ $in: rows.flatMap((row) => fields.flatMap((field) => row[field] ? [row[field]] : [])) }) }).select('_id firstName lastName employeeCode').session(session ?? null).lean();
  const branches = await BranchModel.find({ _id: trusted({ $in: rows.map((row) => row.branchId) }) }).select('_id branchName branchCode').session(session ?? null).lean();
  const people = new Map(users.map((user) => [user._id.toHexString(), user])); const offices = new Map(branches.map((branch) => [branch._id.toHexString(), branch]));
  return rows.map((row) => {
    const labels: Record<string, string | null> = {};
    for (const field of fields) {
      const id = row[field]; const person = id ? people.get(id.toHexString()) : undefined; const prefix = field === 'telecallerId' ? 'telecaller' : field;
      labels[`${prefix}Name`] = person ? `${person.firstName} ${person.lastName}`.trim() : null; labels[`${prefix}Code`] = person?.employeeCode ?? null;
    }
    return { ...row, ...labels, branchName: offices.get(row.branchId.toHexString())?.branchName ?? null, branchCode: offices.get(row.branchId.toHexString())?.branchCode ?? null };
  });
}
