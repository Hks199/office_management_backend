import { Router } from 'express';
import Joi from 'joi';
import { Types, trusted } from 'mongoose';
import type { AuthService } from '../auth/auth.service.js';
import type { Principal } from '../auth/auth.types.js';
import { principalFrom, bodyFrom } from '../auth/auth.controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { validate } from '../../middleware/validate.js';
import { objectIdSchema } from '../../shared/utils/validation-schemas.js';
import { sendSuccess } from '../../shared/utils/response.js';
import { ScopeService, type ScopeResource } from '../permissions/authorization.service.js';
import type { PermissionCode } from '../../constants/permissions.js';
import { UserModel } from '../users/user.model.js';
import { BranchModel } from '../branches/branch.model.js';
import { RoleModel } from '../roles/role.model.js';
import { PermissionModel } from '../permissions/permission.model.js';
import { StateModel, DistrictModel, BlockModel } from '../locations/location.model.js';
import { CustomerModel, LeadModel } from '../leads/commercial.models.js';
import { commercialAdapter, leadAdapter } from '../leads/commercial-access.js';
import { ReportModel } from '../reports/report.model.js';
import { reportAdapter } from '../reports/report.service.js';
import { TargetModel } from '../targets/target.model.js';
import { targetAdapter } from '../targets/target.repository.js';
import { FileModel } from '../files/file.model.js';
import { businessDate } from '../../shared/utils/business-date.js';

const kinds = ['employee', 'branch', 'role', 'permission', 'state', 'district', 'block', 'contact', 'lead', 'report', 'target', 'file'] as const;
type Kind = typeof kinds[number];
interface Reference { kind: Kind; id: string }
const schema = Joi.object({ references: Joi.array().items(Joi.object({ kind: Joi.string().valid(...kinds).required(), id: objectIdSchema.required() })).min(1).max(100).required() }).required();
const scopes = new ScopeService();

async function resolve(actor: Principal, kind: Kind, ids: Types.ObjectId[]) {
  const requested = { _id: trusted({ $in: ids }) };
  const scoped = async (permission: PermissionCode, adapter?: ScopeResource) => {
    if (!actor.grants.some(grant => grant.permission === permission)) return null;
    if (!adapter) return actor.grants.some(grant => grant.permission === permission && grant.scope === 'ALL') ? requested : null;
    return { $and: [requested, await scopes.predicate(actor, permission, adapter)] };
  };
  switch (kind) {
    case 'employee': {
      const filter = await scoped('users:read', { ownerField: '_id', branchField: 'branchId' });
      return filter ? (await UserModel.find(filter).select('_id firstName lastName employeeCode').lean()).map(row => ({ id: row._id.toHexString(), name: `${row.firstName} ${row.lastName}`.trim(), code: row.employeeCode })) : [];
    }
    case 'branch': {
      const filter = await scoped('branches:read', { branchField: '_id', hierarchyBranches: true });
      return filter ? (await BranchModel.find(filter).select('_id branchName branchCode').lean()).map(row => ({ id: row._id.toHexString(), name: row.branchName, code: row.branchCode })) : [];
    }
    case 'role': {
      const filter = await scoped('roles:read');
      return filter ? (await RoleModel.find(filter).select('_id name code').lean()).map(row => ({ id: row._id.toHexString(), name: row.name, code: row.code })) : [];
    }
    case 'permission': {
      const filter = await scoped('permissions:read');
      return filter ? (await PermissionModel.find(filter).select('_id code').lean()).map(row => ({ id: row._id.toHexString(), name: row.code, code: row.code })) : [];
    }
    case 'state': case 'district': case 'block': {
      const filter = await scoped('locations:read');
      if (!filter) return [];
      const rows = kind === 'state' ? await StateModel.find(filter).select('_id name code').lean() : kind === 'district' ? await DistrictModel.find(filter).select('_id name code').lean() : await BlockModel.find(filter).select('_id name code').lean();
      return rows.map(row => ({ id: row._id.toHexString(), name: row.name, code: row.code }));
    }
    case 'contact': {
      const filter = await scoped('customers:read', commercialAdapter);
      return filter ? (await CustomerModel.find(filter).select('_id customerName').lean()).map(row => ({ id: row._id.toHexString(), name: row.customerName, code: '' })) : [];
    }
    case 'lead': {
      const filter = await scoped('leads:read', leadAdapter);
      return filter ? (await LeadModel.find(filter).select('_id customerName leadCode').lean()).map(row => ({ id: row._id.toHexString(), name: row.customerName, code: row.leadCode })) : [];
    }
    case 'report': {
      const filter = await scoped('reports:read', reportAdapter);
      return filter ? (await ReportModel.find(filter).select('_id kind customerName businessDate').lean()).map(row => ({ id: row._id.toHexString(), name: `${row.kind === 'CALL' ? 'Call' : 'Visit'}: ${row.customerName} (${row.businessDate})`, code: '' })) : [];
    }
    case 'target': {
      const filter = await scoped('targets:read', targetAdapter);
      return filter ? (await TargetModel.find(filter).select('_id targetType startDate').lean()).map(row => ({ id: row._id.toHexString(), name: `${row.targetType.replaceAll('_', ' ')} target (${businessDate(row.startDate)})`, code: '' })) : [];
    }
    case 'file': {
      if (!actor.grants.some(grant => grant.permission === 'files:read')) return [];
      // Parent-bound file policies remain authoritative; only resolve directly owned files here.
      return (await FileModel.find({ ...requested, ownerId: actor.userId }).select('_id filename purpose').lean()).map(row => ({ id: row._id.toHexString(), name: row.filename ?? row.purpose.replaceAll('_', ' '), code: '' }));
    }
  }
}

export function displayRoutes(auth: AuthService): Router {
  const router = Router();
  router.post('/display-references', authenticate(auth), validate({ body: schema }), async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const { references } = bodyFrom<{ references: Reference[] }>(res);
    const actor = principalFrom(res);
    const groups = await Promise.all(kinds.map(async kind => {
      const ids = [...new Set(references.filter(reference => reference.kind === kind).map(reference => reference.id))].map(id => new Types.ObjectId(id));
      return ids.length ? (await resolve(actor, kind, ids)).map(row => ({ ...row, kind })) : [];
    }));
    sendSuccess(res, groups.flat(), 'Readable references retrieved');
  });
  return router;
}
