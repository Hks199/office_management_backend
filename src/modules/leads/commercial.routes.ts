import { Router, type Response } from 'express';
import { Types } from 'mongoose';
import type { AuthService } from '../auth/auth.service.js';
import type { AppConfig } from '../../config/env.js';
import { authenticate } from '../../middleware/authenticate.js';
import { authorize } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { idParams } from '../roles/role.validator.js';
import { bodyFrom, principalFrom } from '../auth/auth.controller.js';
import { sendSuccess } from '../../shared/utils/response.js';
import { pageMeta } from '../../shared/utils/query.js';
import { AppError } from '../../shared/errors/app-error.js';
import { CustomerService } from '../customers/customer.service.js';
import { LeadService } from './lead.service.js';
import { LeadRoutingService } from './lead-routing.service.js';
import { SalesCustomerService, salesCustomerQuerySchema, type SalesCustomerQuery } from '../sales-customers/customer.service.js';
import { WorkflowService } from './workflow.service.js';
import { ImportService, type ImportCreate, type ImportQuery } from '../csv-imports/import.service.js';
import { ExportService } from '../csv-imports/export.service.js';
import type { CommercialStorage } from '../csv-imports/commercial-storage.js';
import type { CommercialQuery, LeadInput, LeadUpdate, AssignmentInput, StatusInput, ConversionInput } from './commercial.types.js';
import type { LeadStatus, REFERENCE_CATEGORIES } from './commercial.models.js';
import { commercialQuerySchema, customerQuerySchema, leadCreateSchema, leadUpdateSchema, assignmentSchema, statusSchema, conversionSchema, bulkAssignmentSchema,
  customerStatusSchema, proposalReviewSchema, referenceCreateSchema, referenceUpdateSchema, referenceQuerySchema, workflowSchema, duplicateSettingsSchema, routeLeadSchema } from './commercial.validator.js';
import { csvUploadSchema, importCreateSchema, importConfirmSchema, importQuerySchema, importRowQuerySchema, importAssigneeQuerySchema } from '../csv-imports/import.validator.js';
const idFrom = (res: Response) => new Types.ObjectId((res.locals.validated?.params as { id: string }).id);
const queryFrom = (res: Response) => res.locals.validated?.query as CommercialQuery;
export function commercialRoutes(config: AppConfig, auth: AuthService, storage?: CommercialStorage): Router {
  const router = Router(); const customers = new CustomerService(); const leads = new LeadService(); const workflow = new WorkflowService();
  const imports = new ImportService(config, storage); const exports = new ExportService(config, storage);
  const salesCustomers = new SalesCustomerService();
  const routing = new LeadRoutingService();
  // Authenticate only these module paths: this router shares /api/v1 with unrelated modules/docs.
  router.use(['/customers', '/sales-customers', '/leads', '/csv-imports', '/lead-assignment-proposals', '/lead-workflows', '/reference-values', '/commercial-settings'], authenticate(auth), (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  router.get('/leads/branch-options', authorize('leads:create'), validate({ query: importAssigneeQuerySchema }), async (_req, res) => {
    const query = res.locals.validated?.query as { page: number; limit: number; search?: string }; const result = await routing.branches(principalFrom(res), query);
    sendSuccess(res, result.data, 'Receiving branches retrieved', 200, pageMeta({ ...query, sortOrder: 'asc' }, result.total));
  });
  router.get('/leads/:id/assignees', authorize('leads:assign'), authorize('leads:read'), validate({ params: idParams, query: importAssigneeQuerySchema }), async (_req, res) => {
    const query = res.locals.validated?.query as { page: number; limit: number; search?: string }; const result = await routing.assignees(principalFrom(res), idFrom(res), query);
    sendSuccess(res, result.data, 'Eligible sales executives retrieved', 200, pageMeta({ ...query, sortOrder: 'asc' }, result.total));
  });
  router.post('/leads/:id/route', authorize('leads:route'), validate({ params: idParams, body: routeLeadSchema }), async (_req, res) => {
    sendSuccess(res, await routing.route(principalFrom(res), idFrom(res), bodyFrom<{ revision: number; branchId: string; reason: string }>(res), res.locals), 'Lead routed to branch');
  });
  router.get('/sales-customers', authorize('leads:read'), validate({ query: salesCustomerQuerySchema }), async (_req, res) => {
    const query = res.locals.validated?.query as SalesCustomerQuery; const result = await salesCustomers.list(principalFrom(res), query);
    sendSuccess(res, result.data, 'Customers retrieved', 200, pageMeta(query, result.total));
  });
  router.get('/sales-customers/:id', authorize('leads:read'), validate({ params: idParams }), async (_req, res) => {
    sendSuccess(res, await salesCustomers.get(principalFrom(res), idFrom(res)));
  });
  router.get('/customers', authorize('customers:read'), validate({ query: customerQuerySchema }), async (_req, res) => {
    const query = queryFrom(res); const result = await customers.list(principalFrom(res), query); sendSuccess(res, result.data, 'Contacts retrieved', 200, pageMeta(query, result.total));
  });
  router.post('/customers/assignments', authorize('customers:assign'), validate({ body: bulkAssignmentSchema }), async (_req, res) => {
    sendSuccess(res, await customers.assign(principalFrom(res), bodyFrom<{ items: { id: string; revision: number }[]; assignedTo: string; reason: string }>(res), res.locals), 'Contacts assigned');
  });
  router.get('/customers/:id', authorize('customers:read'), validate({ params: idParams }), async (_req, res) => { sendSuccess(res, await customers.get(principalFrom(res), idFrom(res))); });
  router.patch('/customers/:id/status', authorize('customers:read'), validate({ params: idParams, body: customerStatusSchema }), async (_req, res) => {
    sendSuccess(res, await customers.status(principalFrom(res), idFrom(res), bodyFrom<{ revision: number; status: 'AVAILABLE' | 'INTERESTED' | 'NOT_INTERESTED'; reason: string }>(res), res.locals));
  });
  router.get('/customers/:id/assignments', authorize('customers:read'), validate({ params: idParams, query: customerQuerySchema }), async (_req, res) => { sendSuccess(res, await customers.history(principalFrom(res), idFrom(res), queryFrom(res))); });
  router.post('/customers/:id/convert', authorize('leads:create'), authorize('customers:read'), validate({ params: idParams, body: conversionSchema }), async (req, res) => {
    const key = req.get('Idempotency-Key'); if (!key || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Supply a 16-100 character Idempotency-Key');
    sendSuccess(res, await leads.convert(principalFrom(res), idFrom(res), bodyFrom<ConversionInput>(res), key, res.locals), 'Contact converted');
  });
  router.get('/leads', authorize('leads:read'), validate({ query: commercialQuerySchema }), async (_req, res) => {
    const query = queryFrom(res); const result = await leads.list(principalFrom(res), query); sendSuccess(res, result.data, 'Leads retrieved', 200, pageMeta(query, result.total));
  });
  router.post('/leads', authorize('leads:create'), validate({ body: leadCreateSchema }), async (_req, res) => { sendSuccess(res, await leads.create(principalFrom(res), bodyFrom<LeadInput>(res), res.locals), 'Lead created', 201); });
  router.post('/leads/exports', authorize('leads:export'), authorize('leads:read'), validate({ body: commercialQuerySchema.required() }), async (_req, res) => { sendSuccess(res, await exports.create(principalFrom(res), bodyFrom<CommercialQuery>(res), res.locals), 'Export queued', 202); });
  router.get('/leads/exports/:id', authorize('leads:export'), validate({ params: idParams }), async (_req, res) => { sendSuccess(res, await exports.get(principalFrom(res), idFrom(res))); });
  router.get('/leads/exports/:id/download', authorize('leads:export'), authorize('leads:read'), validate({ params: idParams }), async (_req, res) => { sendSuccess(res, await exports.download(principalFrom(res), idFrom(res))); });
  router.get('/leads/:id', authorize('leads:read'), validate({ params: idParams }), async (_req, res) => { sendSuccess(res, await leads.get(principalFrom(res), idFrom(res))); });
  router.get('/leads/:id/status-options', authorize('leads:read'), authorize('leads:update'), validate({ params: idParams }), async (_req, res) => { sendSuccess(res, await leads.statusOptions(principalFrom(res), idFrom(res)), 'Allowed lead statuses retrieved'); });
  router.patch('/leads/:id', authorize('leads:update'), validate({ params: idParams, body: leadUpdateSchema }), async (_req, res) => { sendSuccess(res, await leads.update(principalFrom(res), idFrom(res), bodyFrom<LeadUpdate>(res), res.locals)); });
  router.post('/leads/:id/assignments', authorize('leads:assign'), validate({ params: idParams, body: assignmentSchema }), async (_req, res) => { sendSuccess(res, await leads.assign(principalFrom(res), idFrom(res), bodyFrom<AssignmentInput>(res), res.locals)); });
  router.patch('/leads/:id/status', authorize('leads:update'), validate({ params: idParams, body: statusSchema }), async (_req, res) => { sendSuccess(res, await leads.status(principalFrom(res), idFrom(res), bodyFrom<StatusInput>(res), res.locals)); });
  router.post('/leads/:id/assignment-proposals', authorize('leads:propose_assignment'), validate({ params: idParams, body: assignmentSchema }), async (_req, res) => { sendSuccess(res, await leads.propose(principalFrom(res), idFrom(res), bodyFrom<AssignmentInput>(res), res.locals), 'Proposal created', 201); });
  for (const [path, kind] of [['assignments', 'assignments'], ['status-history', 'status'], ['assignment-proposals', 'proposals']] as const) router.get(`/leads/:id/${path}`, authorize('leads:read'), validate({ params: idParams, query: commercialQuerySchema }), async (_req, res) => { sendSuccess(res, await leads.history(principalFrom(res), idFrom(res), kind, queryFrom(res))); });
  router.patch('/lead-assignment-proposals/:id', authorize('leads:assign'), validate({ params: idParams, body: proposalReviewSchema }), async (_req, res) => { sendSuccess(res, await leads.reviewProposal(principalFrom(res), idFrom(res), bodyFrom<{ status: 'APPROVED' | 'REJECTED'; reason: string }>(res), res.locals)); });
  router.get('/lead-workflows', authorize('leads:read'), async (_req, res) => { sendSuccess(res, await workflow.workflow(principalFrom(res))); });
  router.post('/lead-workflows', authorize('settings:manage'), validate({ body: workflowSchema }), async (_req, res) => { sendSuccess(res, await workflow.saveWorkflow(principalFrom(res), bodyFrom<{ expectedVersion: number; transitions: { from: LeadStatus; to: LeadStatus }[] }>(res), res.locals), 'Workflow created', 201); });
  router.get('/reference-values', authorize('locations:read'), validate({ query: referenceQuerySchema }), async (_req, res) => {
    const query = res.locals.validated?.query as { category: typeof REFERENCE_CATEGORIES[number]; isActive: boolean }; sendSuccess(res, await workflow.listReferences(principalFrom(res), query.category, query.isActive));
  });
  router.post('/reference-values', authorize('settings:manage'), validate({ body: referenceCreateSchema }), async (_req, res) => { sendSuccess(res, await workflow.reference(principalFrom(res), bodyFrom<{ category: typeof REFERENCE_CATEGORIES[number]; code: string; label: string }>(res), res.locals), 'Reference created', 201); });
  router.patch('/reference-values/:id', authorize('settings:manage'), validate({ params: idParams, body: referenceUpdateSchema }), async (_req, res) => { sendSuccess(res, await workflow.updateReference(principalFrom(res), idFrom(res), bodyFrom<{ revision: number; label?: string; isActive?: boolean }>(res), res.locals)); });
  router.get('/commercial-settings', authorize('settings:manage'), async (_req, res) => { sendSuccess(res, await workflow.settings(principalFrom(res))); });
  router.patch('/commercial-settings', authorize('settings:manage'), validate({ body: duplicateSettingsSchema }), async (_req, res) => { sendSuccess(res, await workflow.saveSettings(principalFrom(res), bodyFrom<{ revision: number; duplicateScope: 'BRANCH' | 'COMPANY' }>(res), res.locals)); });
  router.post('/csv-imports/upload-intents', authorize('imports:create'), authorize('leads:import'), authorize('files:upload'), validate({ body: csvUploadSchema }), async (_req, res) => { sendSuccess(res, await imports.upload(principalFrom(res), bodyFrom<{ filename: string; size: number; checksumSHA256: string }>(res), res.locals), 'CSV upload authorized', 201); });
  router.post('/csv-imports/files/:id/confirm', authorize('imports:create'), authorize('leads:import'), authorize('files:upload'), validate({ params: idParams }), async (_req, res) => { sendSuccess(res, await imports.confirmUpload(principalFrom(res), idFrom(res), res.locals), 'CSV upload confirmed'); });
  router.post('/csv-imports', authorize('imports:create'), authorize('leads:import'), validate({ body: importCreateSchema }), async (_req, res) => { sendSuccess(res, await imports.create(principalFrom(res), bodyFrom<ImportCreate>(res), res.locals), 'Import validation queued', 202); });
  router.get('/csv-imports', authorize('imports:read'), validate({ query: importQuerySchema }), async (_req, res) => {
    const query = res.locals.validated?.query as ImportQuery; const result = await imports.list(principalFrom(res), query); sendSuccess(res, result.data, 'Imports retrieved', 200, pageMeta(query, result.total));
  });
  router.get('/csv-imports/:id', authorize('imports:read'), validate({ params: idParams }), async (_req, res) => { sendSuccess(res, await imports.get(principalFrom(res), idFrom(res))); });
  router.get('/csv-imports/:id/rows', authorize('imports:read'), validate({ params: idParams, query: importRowQuerySchema }), async (_req, res) => {
    const query = res.locals.validated?.query as { page: number; limit: number; status?: string }; const result = await imports.rows(principalFrom(res), idFrom(res), query); sendSuccess(res, result.data, 'Import rows retrieved', 200, pageMeta({ ...query, sortOrder: 'asc' }, result.total));
  });
  router.post('/csv-imports/:id/confirm', authorize('imports:confirm'), authorize('leads:import'), authorize('customers:assign'), validate({ params: idParams, body: importConfirmSchema }), async (_req, res) => { sendSuccess(res, await imports.confirm(principalFrom(res), idFrom(res), bodyFrom<{ revision: number; assignedTo: string }>(res), res.locals), 'Import commit queued', 202); });
  router.get('/csv-imports/:id/assignees', authorize('imports:confirm'), authorize('leads:import'), authorize('customers:assign'), validate({ params: idParams, query: importAssigneeQuerySchema }), async (_req, res) => {
    const query = res.locals.validated?.query as { page: number; limit: number; search?: string };
    const result = await imports.assignees(principalFrom(res), idFrom(res), query);
    sendSuccess(res, result.data, 'Eligible Telecallers retrieved', 200, pageMeta({ ...query, sortOrder: 'asc' }, result.total));
  });
  return router;
}
