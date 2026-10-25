import { Types, trusted, type ClientSession } from 'mongoose';
import type { Principal } from '../auth/auth.types.js';
import { CustomerModel, AssignmentModel } from '../leads/commercial.models.js';
import { CommercialAccess, commercialAdapter } from '../leads/commercial-access.js';
import { listCommercial } from '../leads/commercial.repository.js';
import type { CommercialQuery } from '../leads/commercial.types.js';
import { OrganizationAccess } from '../../shared/services/organization-access.js';
import { audit, type AuditContext } from '../activity-logs/audit.service.js';
import { AppError } from '../../shared/errors/app-error.js';
import { UserModel } from '../users/user.model.js';
import { BranchModel } from '../branches/branch.model.js';

interface CustomerReferences {
  assignedTo?: Types.ObjectId | null | undefined;
  assignedBy?: Types.ObjectId | null | undefined;
  previousAssigneeId?: Types.ObjectId | null | undefined;
  createdBy?: Types.ObjectId | null | undefined;
  branchId?: Types.ObjectId | null | undefined;
}

export class CustomerService {
  private readonly access = new OrganizationAccess(); private readonly commercial = new CommercialAccess();
  private async withLabels<T extends CustomerReferences>(records: T[], session?: ClientSession) {
    if (!records.length) return [];
    const userFields = ['assignedTo', 'assignedBy', 'previousAssigneeId', 'createdBy'] as const;
    const ids = (values: (Types.ObjectId | null | undefined)[]) => [...new Set(values.filter((id): id is Types.ObjectId => Boolean(id)).map((id) => id.toHexString()))].map((id) => new Types.ObjectId(id));
    // Enrich only references from already-authorized records, without directory permissions
    // or employee contact details. Include inactive employees to preserve existing attribution.
    const users = await UserModel.find({ _id: trusted({ $in: ids(records.flatMap((record) => userFields.map((field) => record[field]))) }) })
      .select('_id firstName lastName employeeCode').session(session ?? null).lean();
    const branches = await BranchModel.find({ _id: trusted({ $in: ids(records.map((record) => record.branchId)) }) })
      .select('_id branchName branchCode').session(session ?? null).lean();
    const people = new Map(users.map((user) => [user._id.toHexString(), user]));
    const offices = new Map(branches.map((branch) => [branch._id.toHexString(), branch]));
    return records.map((record) => {
      const labels: Record<string, string | null> = {};
      for (const field of userFields) {
        if (!(field in record)) continue;
        const id = record[field]; const person = id ? people.get(id.toHexString()) : undefined;
        const prefix = field === 'previousAssigneeId' ? 'previousAssignee' : field;
        labels[`${prefix}Name`] = person ? `${person.firstName} ${person.lastName}`.trim() : null;
        labels[`${prefix}Code`] = person?.employeeCode ?? null;
      }
      if ('branchId' in record) {
        const branch = record.branchId ? offices.get(record.branchId.toHexString()) : undefined;
        labels.branchName = branch?.branchName ?? null; labels.branchCode = branch?.branchCode ?? null;
      }
      return { ...record, ...labels };
    });
  }
  async list(actor: Principal, query: CommercialQuery) {
    const result = await listCommercial('customers', await this.commercial.scopes.predicate(actor, 'customers:read', commercialAdapter), query);
    return { ...result, data: await this.withLabels<(typeof result.data)[number]>(result.data) };
  }
  async get(actor: Principal, id: Types.ObjectId) {
    const customer = await CustomerModel.findOne({ $and: [{ _id: id }, await this.commercial.scopes.predicate(actor, 'customers:read', commercialAdapter)] }).lean();
    if (!customer) throw new AppError(404, 'NOT_FOUND', 'Contact not found');
    const labeled = (await this.withLabels([customer]))[0];
    if (!labeled) throw new Error('Contact label resolution failed');
    return labeled;
  }
  async assign(actor: Principal, input: { items: { id: string; revision: number }[]; assignedTo: string; reason: string }, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'customers:assign', session); const assignedTo = new Types.ObjectId(input.assignedTo);
      const scope = await this.commercial.scopes.predicate(current, 'customers:assign', commercialAdapter, session); const ids: Types.ObjectId[] = [];
      for (const item of input.items) {
        const previous = await CustomerModel.findOne({ $and: [{ _id: new Types.ObjectId(item.id) }, scope] }).session(session).lean();
        if (!previous) throw new AppError(404, 'NOT_FOUND', 'Contact not found');
        if (previous.status === 'CONVERTED') throw new AppError(409, 'CUSTOMER_CONVERTED', 'Converted contacts cannot be reassigned');
        await this.commercial.recipient(assignedTo, previous.branchId, 'customers', session);
        await this.commercial.destination(current, 'customers:assign', previous.branchId, assignedTo, session);
        const record = await CustomerModel.findOneAndUpdate({ _id: previous._id, revision: item.revision }, { $set: { assignedTo, assignedBy: current.userId, assignedAt: new Date() }, $inc: { revision: 1 } }, { session, returnDocument: 'after' }).lean();
        if (!record) throw new AppError(409, 'CONFLICT', 'Contact changed; reload revisions');
        await AssignmentModel.create([{ entityType: 'CUSTOMER', entityId: previous._id, previousAssigneeId: previous.assignedTo, assignedTo,
          assignedBy: current.userId, reason: input.reason, entityRevision: record.revision }], { session }); ids.push(record._id);
        await audit(session, context, 'CUSTOMER_ASSIGNED', current.userId, 'customer', record._id, { assignedTo: input.assignedTo, reason: input.reason });
      }
      return { customerIds: ids };
    });
  }
  async status(actor: Principal, id: Types.ObjectId, input: { revision: number; status: 'AVAILABLE' | 'INTERESTED' | 'NOT_INTERESTED'; reason: string }, context: AuditContext) {
    return this.access.transaction(async (session) => {
      const current = await this.access.actor(actor, 'customers:read', session);
      const previous = await CustomerModel.findOne({ $and: [{ _id: id }, await this.commercial.scopes.predicate(current, 'customers:read', commercialAdapter, session)] }).session(session).lean();
      if (!previous) throw new AppError(404, 'NOT_FOUND', 'Contact not found');
      if (!previous.assignedTo.equals(current.userId)) {
        const scope = await this.commercial.scopes.predicate(current, 'customers:assign', commercialAdapter, session);
        if (!await CustomerModel.exists({ $and: [{ _id: id }, scope] }).session(session)) throw new AppError(404, 'NOT_FOUND', 'Contact not found');
      }
      if (previous.status === 'CONVERTED') throw new AppError(409, 'CUSTOMER_CONVERTED', 'Converted contact status is immutable');
      const record = await CustomerModel.findOneAndUpdate({ _id: id, revision: input.revision }, { $set: { status: input.status }, $inc: { revision: 1 } }, { session, returnDocument: 'after' }).lean();
      if (!record) throw new AppError(409, 'CONFLICT', 'Contact changed; reload its revision');
      await audit(session, context, 'CUSTOMER_STATUS_CHANGED', current.userId, 'customer', id, { before: previous.status, after: input.status, reason: input.reason });
      return (await this.withLabels([record], session))[0];
    });
  }
  async history(actor: Principal, id: Types.ObjectId, query: CommercialQuery) {
    await this.get(actor, id);
    const records = await AssignmentModel.find({ entityType: 'CUSTOMER', entityId: id }).sort({ createdAt: -1, _id: 1 }).skip((query.page - 1) * query.limit).limit(query.limit).lean();
    return this.withLabels(records);
  }
}
