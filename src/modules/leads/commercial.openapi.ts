import type { OpenAPIV3 } from 'openapi-types';
import { LEAD_STATUSES, REFERENCE_CATEGORIES } from './commercial.models.js';
const id: OpenAPIV3.SchemaObject = { type: 'string', pattern: '^[a-f0-9]{24}$' };
const revision: OpenAPIV3.SchemaObject = { type: 'integer', minimum: 0 };
const reason: OpenAPIV3.SchemaObject = { type: 'string', minLength: 3, maxLength: 500 };
const time: OpenAPIV3.SchemaObject = { type: 'string', format: 'date-time' };
const code: OpenAPIV3.SchemaObject = { type: 'string', pattern: '^[A-Z0-9_-]{1,32}$' };
const decimal: OpenAPIV3.SchemaObject = { type: 'string', pattern: '^(0|[1-9][0-9]{0,7})(\\.[0-9]{1,2})?$' };
const ref = (name: string): OpenAPIV3.ReferenceObject => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject>, required: string[] = []): OpenAPIV3.SchemaObject => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const contact = { customerName: { type: 'string', minLength: 1, maxLength: 150 } as OpenAPIV3.SchemaObject, mobileNumber: { type: 'string', maxLength: 30 } as OpenAPIV3.SchemaObject,
  alternateNumber: { type: 'string', maxLength: 30 } as OpenAPIV3.SchemaObject, stateId: id, districtId: id, blockId: { ...id, nullable: true }, tehsil: { type: 'string', maxLength: 100 } as OpenAPIV3.SchemaObject,
  siteAddress: { type: 'string', minLength: 3, maxLength: 1000 } as OpenAPIV3.SchemaObject, remarks: { type: 'string', maxLength: 2000 } as OpenAPIV3.SchemaObject };
const requirements = { requiredCapacityKw: decimal, ratePerKw: decimal, paymentMode: code, panelBrand: code, panelTechnology: code, leadSource: code, nextFollowUpAt: { ...time, nullable: true } };
const requiredRequirements = ['requiredCapacityKw', 'ratePerKw', 'paymentMode', 'panelBrand', 'panelTechnology', 'leadSource'];
const transition = object({ from: { type: 'string', enum: [...LEAD_STATUSES] }, to: { type: 'string', enum: [...LEAD_STATUSES] } }, ['from', 'to']);
const status: OpenAPIV3.SchemaObject = { type: 'string', enum: [...LEAD_STATUSES] };
const fileFields = object({ method: { type: 'string', enum: ['POST'] }, url: { type: 'string', format: 'uri' }, fields: { type: 'object', additionalProperties: { type: 'string' } } });
const queryProperties = { page: { type: 'integer', minimum: 1, maximum: 10000, default: 1 } as OpenAPIV3.SchemaObject,
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 } as OpenAPIV3.SchemaObject, sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } as OpenAPIV3.SchemaObject,
  branchId: id, assignedTo: id, createdBy: id, stateId: id, districtId: id, blockId: id, status, search: { type: 'string', minLength: 2, maxLength: 150 } as OpenAPIV3.SchemaObject,
  startDate: time, endDate: time, followUpFrom: time, followUpTo: time, leadSource: code,
  assignmentState: { type: 'string', enum: ['UNASSIGNED', 'ASSIGNED'] } as OpenAPIV3.SchemaObject };
export const commercialSchemas: Record<string, OpenAPIV3.SchemaObject> = {
  ImportTelecallerOption: object({ _id: id, firstName: { type: 'string' }, lastName: { type: 'string' }, employeeCode: { type: 'string' } }, ['_id', 'firstName', 'lastName', 'employeeCode']),
  LeadBranchOption: object({ _id: id, branchName: { type: 'string' }, branchCode: { type: 'string' }, address: { type: 'string' }, label: { type: 'string' } }),
  LeadRoute: object({ revision, branchId: id, reason }, ['revision', 'branchId', 'reason']),
  LeadRequirements: object(requirements, requiredRequirements),
  LeadCreate: object({ ...contact, ...requirements, branchId: id, assignedTo: { ...id, nullable: true } }, ['customerName', 'mobileNumber', 'stateId', 'districtId', 'siteAddress', 'branchId', ...requiredRequirements]),
  LeadUpdate: { ...object({ ...contact, ...requirements, revision }, ['revision']), minProperties: 2 },
  Lead: object({ ...contact, ...requirements, _id: id, leadCode: { type: 'string' }, sourceCustomerId: { ...id, nullable: true }, branchId: id,
    confirmedCustomerId: { ...id, nullable: true }, confirmedCustomerCode: { type: 'string', nullable: true },
    assignmentState: { type: 'string', enum: ['UNASSIGNED', 'ASSIGNED'] }, routedBy: { ...id, nullable: true }, routedAt: { ...time, nullable: true },
    ...Object.fromEntries(['assignedToName', 'assignedToCode', 'assignedByName', 'assignedByCode', 'createdByName', 'createdByCode', 'routedByName', 'routedByCode', 'telecallerName', 'telecallerCode', 'branchName', 'branchCode'].map((field) => [field, { type: 'string', nullable: true }])),
    estimatedProjectValue: { type: 'string', description: 'Server-computed exact INR decimal' }, status, resumeStatus: { ...status, nullable: true },
    assignedTo: { ...id, nullable: true }, assignedBy: { ...id, nullable: true }, assignedAt: { ...time, nullable: true }, createdBy: id,
    telecallerId: { ...id, nullable: true }, salesExecutiveId: { ...id, nullable: true }, workflowVersion: { type: 'integer' }, lastContactedAt: { ...time, nullable: true }, revision, createdAt: time, updatedAt: time }),
  Customer: object({ ...contact, _id: id, branchId: id, assignedTo: id, assignedBy: id, assignedAt: time, createdBy: id,
    ...Object.fromEntries(['assignedToName', 'assignedToCode', 'assignedByName', 'assignedByCode', 'createdByName', 'createdByCode', 'branchName', 'branchCode'].map((field) => [field, { type: 'string', nullable: true }])),
    status: { type: 'string', enum: ['AVAILABLE', 'INTERESTED', 'NOT_INTERESTED', 'CONVERTED'] }, leadId: { ...id, nullable: true }, importId: id, importRow: { type: 'integer' }, revision, createdAt: time, updatedAt: time }),
  SalesCustomer: object({ _id: id, leadId: id, leadCode: { type: 'string' }, leadStatus: status, customerCode: { type: 'string' }, name: { type: 'string' },
    mobileNumber: { type: 'string' }, alternateNumber: { type: 'string' }, siteAddress: { type: 'string' },
    requiredCapacityKw: decimal, ratePerKw: decimal, projectValue: { type: 'string' }, paymentMode: code, panelBrand: code, panelTechnology: code, leadSource: code,
    branchId: id, branchName: { type: 'string', nullable: true }, branchCode: { type: 'string', nullable: true }, assignedTo: { ...id, nullable: true },
    assignedToName: { type: 'string', nullable: true }, assignedToCode: { type: 'string', nullable: true }, confirmedBy: id, confirmedByName: { type: 'string', nullable: true }, confirmedByCode: { type: 'string', nullable: true },
    status: { type: 'string', enum: ['CONFIRMED', 'REVIEW_REQUIRED'] }, firstConvertedAt: time, confirmedAt: time, createdAt: time, updatedAt: time }),
  CustomerConversion: object({ revision, requirements: ref('LeadRequirements'), branchId: id, proposedSalesExecutiveId: id }, ['revision', 'requirements']),
  CustomerStatus: object({ revision, reason, status: { type: 'string', enum: ['AVAILABLE', 'INTERESTED', 'NOT_INTERESTED'] } }, ['revision', 'reason', 'status']),
  CommercialAssignment: object({ revision, assignedTo: id, reason }, ['revision', 'assignedTo', 'reason']),
  BulkCustomerAssignment: object({ items: { type: 'array', minItems: 1, maxItems: 100, items: object({ id, revision }, ['id', 'revision']) }, assignedTo: id, reason }, ['items', 'assignedTo', 'reason']),
  BulkAssignmentResult: object({ customerIds: { type: 'array', items: id } }),
  LeadStatusChange: object({ revision, status, reason }, ['revision', 'status', 'reason']),
  LeadStatusOptions: object({ currentStatus: status, revision, workflowVersion: { type: 'integer' }, allowedStatuses: { type: 'array', items: status } }, ['currentStatus', 'revision', 'workflowVersion', 'allowedStatuses']),
  LeadAssignmentHistory: object({ _id: id, entityId: id, entityType: { type: 'string', enum: ['LEAD', 'CUSTOMER'] }, previousAssigneeId: { ...id, nullable: true }, assignedTo: id, assignedBy: id, reason, entityRevision: revision, createdAt: time,
    ...Object.fromEntries(['assignedToName', 'assignedToCode', 'assignedByName', 'assignedByCode', 'previousAssigneeName', 'previousAssigneeCode'].map((field) => [field, { type: 'string', nullable: true }])) }),
  LeadStatusHistory: object({ _id: id, leadId: id, fromStatus: { ...status, nullable: true }, toStatus: status, actorId: id, workflowVersion: { type: 'integer' }, leadRevision: revision, reason,
    valueAtConversion: { type: 'string', nullable: true }, createdAt: time }),
  LeadProposal: object({ _id: id, leadId: id, proposedTo: id, proposedBy: id, leadRevision: revision, status: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'] },
    reason, reviewReason: { type: 'string' }, reviewedBy: { ...id, nullable: true }, reviewedAt: { ...time, nullable: true }, expiresAt: time, createdAt: time, updatedAt: time }),
  ProposalReview: object({ status: { type: 'string', enum: ['APPROVED', 'REJECTED'] }, reason }, ['status', 'reason']),
  ReferenceCreate: object({ category: { type: 'string', enum: [...REFERENCE_CATEGORIES] }, code, label: { type: 'string', minLength: 1, maxLength: 100 } }, ['category', 'code', 'label']),
  ReferenceUpdate: { ...object({ revision, label: { type: 'string', minLength: 1, maxLength: 100 }, isActive: { type: 'boolean' } }, ['revision']), minProperties: 2 },
  ReferenceValue: object({ _id: id, category: { type: 'string', enum: [...REFERENCE_CATEGORIES] }, code, label: { type: 'string' }, isActive: { type: 'boolean' }, revision, createdBy: id, createdAt: time, updatedAt: time }),
  LeadWorkflow: object({ _id: id, version: { type: 'integer' }, transitions: { type: 'array', items: transition }, createdBy: id, createdAt: time }),
  LeadWorkflowCreate: object({ expectedVersion: { type: 'integer', minimum: 1 }, transitions: { type: 'array', minItems: 1, maxItems: 100, items: transition } }, ['expectedVersion', 'transitions']),
  DuplicateSettings: object({ revision, duplicateScope: { type: 'string', enum: ['BRANCH', 'COMPANY'] } }, ['revision', 'duplicateScope']),
  CommercialSettings: object({ _id: { type: 'string', enum: ['customers'] }, revision, duplicateScope: { type: 'string', enum: ['BRANCH', 'COMPANY'] }, createdAt: time, updatedAt: time }),
  CsvUpload: object({ filename: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,99}\\.csv$' }, size: { type: 'integer', minimum: 1, maximum: 20971520 },
    checksumSHA256: { type: 'string', pattern: '^[A-Za-z0-9+/]{43}=$' } }, ['filename', 'size', 'checksumSHA256']),
  CsvUploadIntent: object({ fileId: id, expiresAt: time, upload: fileFields }),
  CsvImportCreate: object({ fileId: id, branchId: id, columnMapping: object(Object.fromEntries(['customerName', 'mobileNumber', 'alternateNumber', 'state', 'district', 'block', 'siteAddress', 'remarks'].map((field) => [field, { type: 'string', minLength: 1, maxLength: 100 }])), ['customerName', 'mobileNumber', 'state', 'district', 'siteAddress']) }, ['fileId', 'branchId']),
  CsvImportConfirm: object({ revision, assignedTo: id }, ['revision', 'assignedTo']),
  CsvImport: object({ _id: id, createdBy: id, branchId: id, fileId: id, assignedTo: { ...id, nullable: true }, columnMapping: { type: 'object', additionalProperties: { type: 'string' } },
    ...Object.fromEntries(['createdByName', 'createdByCode', 'assignedToName', 'assignedToCode', 'branchName', 'branchCode', 'fileName'].map((field) => [field, { type: 'string', nullable: true }])),
    duplicateScope: { type: 'string', enum: ['BRANCH', 'COMPANY'] }, status: { type: 'string', enum: ['QUEUED_VALIDATION', 'VALIDATING', 'PREVIEW_READY', 'QUEUED_COMMIT', 'PROCESSING', 'COMPLETED', 'FAILED'] },
    totalRows: { type: 'integer' }, acceptedRows: { type: 'integer' }, rejectedRows: { type: 'integer' }, duplicateRows: { type: 'integer' }, importedRows: { type: 'integer' }, attempts: { type: 'integer' },
    errorCode: { type: 'string' }, revision, requestId: { type: 'string' }, confirmedAt: { ...time, nullable: true }, finishedAt: { ...time, nullable: true }, expiresAt: time, createdAt: time, updatedAt: time }),
  CsvImportRow: object({ _id: id, importId: id, rowNumber: { type: 'integer' }, status: { type: 'string', enum: ['VALID', 'REJECTED', 'DUPLICATE', 'IMPORTED'] },
    normalizedData: { ...object(contact), nullable: true }, rowErrors: { type: 'array', items: { type: 'string' } },
    inputLocation: object({ state: { type: 'string' }, district: { type: 'string' }, block: { type: 'string' } }),
    rowIssues: { type: 'array', items: object({ field: { type: 'string' }, code: { type: 'string' } }) }, expiresAt: time }),
  LeadExportQuery: object(queryProperties),
  LeadExportJob: object({ _id: id, createdBy: id, fileId: { ...id, nullable: true }, status: { type: 'string', enum: ['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'] }, attempts: { type: 'integer' }, errorCode: { type: 'string' }, requestId: { type: 'string' }, expiresAt: time, createdAt: time, updatedAt: time }),
};
const query = (name: string, schema: OpenAPIV3.SchemaObject, required = false): OpenAPIV3.ParameterObject => ({ name, in: 'query', required, schema });
const params = Object.entries(queryProperties).map(([name, schema]) => query(name, schema));
const customerParams = params.map((parameter) => parameter.name === 'status' ? query('status', { type: 'string', enum: ['AVAILABLE', 'INTERESTED', 'NOT_INTERESTED', 'CONVERTED'] }) : parameter);
const pathId: OpenAPIV3.ParameterObject = { name: 'id', in: 'path', required: true, schema: id };
function operation(operationId: string, output: string, summary: string, input?: string, parameters: OpenAPIV3.ParameterObject[] = [], list = false, statusCode = '200'): OpenAPIV3.OperationObject {
  return { operationId, tags: ['Commercial'], summary, security: [{ bearerAuth: [] }], parameters,
    ...(input ? { requestBody: { required: true, content: { 'application/json': { schema: ref(input) } } } } : {}),
    responses: { [statusCode]: { description: 'Successful operation', content: { 'application/json': { schema: object({ success: { type: 'boolean' }, message: { type: 'string' },
      data: list ? { type: 'array', items: ref(output) } : ref(output), ...(list ? { meta: { type: 'object' as const, description: 'Pagination metadata where applicable; history endpoints return bounded arrays' } } : {}),
    }) } } }, ...Object.fromEntries(['400', '401', '403', '404', '409', '429', '500', '503'].map((code) => [code, { description: 'Rejected; see error.code', content: { 'application/json': { schema: ref('ErrorResponse') } } }])) },
  };
}
export const commercialPaths: OpenAPIV3.PathsObject = {
  '/leads/branch-options': { get: operation('leadBranchOptions', 'LeadBranchOption', 'Minimal active receiving branches; routing-capable callers may choose any branch; other creators retain destination scope', undefined,
    [query('page', queryProperties.page), query('limit', queryProperties.limit), query('search', queryProperties.search)], true) },
  '/leads/{id}/assignees': { get: operation('leadSalesExecutiveOptions', 'ImportTelecallerOption', 'Lead-scoped eligible active sales executives in the receiving branch; requires leads:read and leads:assign', undefined,
    [pathId, query('page', queryProperties.page), query('limit', queryProperties.limit), query('search', queryProperties.search)], true) },
  '/leads/{id}/route': { post: operation('routeLeadToBranch', 'Lead', 'Route an owned unassigned open lead to an active branch; revision protected; leads:route', 'LeadRoute', [pathId]) },
  '/sales-customers': { get: operation('salesCustomers', 'SalesCustomer', 'Confirmed customer snapshots filtered by current source-lead read scope', undefined,
    [query('page', queryProperties.page), query('limit', queryProperties.limit), query('sortOrder', queryProperties.sortOrder), query('search', queryProperties.search), query('status', { type: 'string', enum: ['CONFIRMED', 'REVIEW_REQUIRED'] })], true) },
  '/sales-customers/{id}': { get: operation('salesCustomer', 'SalesCustomer', 'Customer details; current source-lead authorization is required', undefined, [pathId]) },
  '/csv-imports/{id}/assignees': { get: operation('commercialImportAssignees', 'ImportTelecallerOption', 'Active eligible Telecallers in the import branch and assignment scope; minimal names only', undefined, [pathId, query('page', queryProperties.page), query('limit', queryProperties.limit), query('search', { type: 'string', minLength: 2, maxLength: 100 })], true) },
  '/customers': { get: operation('commercialCustomers', 'Customer', 'customers:read scoped before filtering/pagination', undefined, customerParams, true) },
  '/customers/{id}': { get: operation('commercialCustomer', 'Customer', 'customers:read scoped individual lookup', undefined, [pathId]) },
  '/customers/assignments': { post: operation('commercialAssignCustomers', 'BulkAssignmentResult', 'Atomic bulk reassignment; current/source/destination scopes and receive capability', 'BulkCustomerAssignment') },
  '/customers/{id}/status': { patch: operation('commercialCustomerStatus', 'Customer', 'Assigned caller or scoped customer manager may mark interest; converted customers immutable', 'CustomerStatus', [pathId]) },
  '/customers/{id}/assignments': { get: operation('commercialCustomerHistory', 'LeadAssignmentHistory', 'Parent-authorized bounded assignment history', undefined, [pathId, ...params], true) },
  '/customers/{id}/convert': { post: operation('commercialConvert', 'Lead', 'Atomic interested-customer conversion; exact body replay returns existing lead', 'CustomerConversion', [pathId, { name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,100}$' } }]) },
  '/leads': { get: operation('commercialLeads', 'Lead', 'leads:read current-assignee scopes and allowlisted filters', undefined, params, true), post: operation('commercialCreateLead', 'Lead', 'leads:create destination scope; another assignee additionally requires leads:assign', 'LeadCreate', [], false, '201') },
  '/leads/{id}': { get: operation('commercialLead', 'Lead', 'Scoped lead detail', undefined, [pathId]), patch: operation('commercialUpdateLead', 'Lead', 'Revision-checked profile/requirements update; computed fields and terminal editing prohibited', 'LeadUpdate', [pathId]) },
  '/leads/{id}/assignments': { post: operation('commercialAssignLead', 'Lead', 'leads:assign old/new scope and eligible same-branch recipient', 'CommercialAssignment', [pathId]), get: operation('commercialLeadAssignments', 'LeadAssignmentHistory', 'Parent-authorized immutable history', undefined, [pathId, ...params], true) },
  '/leads/{id}/status': { patch: operation('commercialLeadStatus', 'Lead', 'Assigned receiving executive may choose any different status on an active lead; other actors follow pinned workflow. Assigned conversion and scoped terminal reopen remain enforced.', 'LeadStatusChange', [pathId]) },
  '/leads/{id}/status-options': { get: operation('commercialLeadStatusOptions', 'LeadStatusOptions', 'Scoped read/update access; all different statuses for assigned receiving executive on active leads, otherwise pinned workflow; controlled terminal reopen', undefined, [pathId]) },
  '/leads/{id}/status-history': { get: operation('commercialLeadStatusHistory', 'LeadStatusHistory', 'Parent-authorized immutable status events', undefined, [pathId, ...params], true) },
  '/leads/{id}/assignment-proposals': { post: operation('commercialPropose', 'LeadProposal', 'Branch-local recommendation, does not assign lead', 'CommercialAssignment', [pathId], false, '201'), get: operation('commercialProposals', 'LeadProposal', 'Parent-authorized proposals', undefined, [pathId, ...params], true) },
  '/lead-assignment-proposals/{id}': { patch: operation('commercialReviewProposal', 'LeadProposal', 'leads:assign; approval rechecks expiry, revision, source/destination and recipient', 'ProposalReview', [pathId]) },
  '/reference-values': { get: operation('commercialReferences', 'ReferenceValue', 'Authenticated locations:read ALL; only configured category', undefined, [query('category', { type: 'string', enum: [...REFERENCE_CATEGORIES] }, true), query('isActive', { type: 'boolean', default: true })], true), post: operation('commercialCreateReference', 'ReferenceValue', 'settings:manage ALL; no fabricated brand/payment defaults', 'ReferenceCreate', [], false, '201') },
  '/reference-values/{id}': { patch: operation('commercialUpdateReference', 'ReferenceValue', 'settings:manage ALL, expected revision; category/code immutable', 'ReferenceUpdate', [pathId]) },
  '/lead-workflows': { get: operation('commercialWorkflow', 'LeadWorkflow', 'Latest workflow; existing leads pin their creation version'), post: operation('commercialCreateWorkflow', 'LeadWorkflow', 'settings:manage ALL; expected version and bounded controlled edges', 'LeadWorkflowCreate', [], false, '201') },
  '/commercial-settings': { get: operation('commercialSettings', 'CommercialSettings', 'settings:manage ALL'), patch: operation('commercialUpdateSettings', 'CommercialSettings', 'Expected revision; duplicate policy freezes after customer data exists', 'DuplicateSettings') },
  '/csv-imports/upload-intents': { post: operation('commercialCsvUpload', 'CsvUploadIntent', 'imports:create + leads:import + files:upload; private checksum-bound CSV POST', 'CsvUpload', [], false, '201') },
  '/csv-imports/files/{id}/confirm': { post: operation('commercialCsvConfirmFile', 'PhotoFile', 'Owner verifies metadata/checksum/version; UTF-8/CSV format is validated in background', undefined, [pathId]) },
  '/csv-imports': { get: operation('commercialImports', 'CsvImport', 'imports:read creator/team/branch scope plus own jobs', undefined, [query('page', queryProperties.page), query('limit', queryProperties.limit), query('sortOrder', queryProperties.sortOrder), query('branchId', id), query('status', { type: 'string', enum: ['QUEUED_VALIDATION', 'VALIDATING', 'PREVIEW_READY', 'QUEUED_COMMIT', 'PROCESSING', 'COMPLETED', 'FAILED'] })], true),
    post: operation('commercialCreateImport', 'CsvImport', 'Fresh owner CSV, branch-scoped import authority; queue bounded streaming preview', 'CsvImportCreate', [], false, '202') },
  '/csv-imports/{id}': { get: operation('commercialImport', 'CsvImport', 'Scoped job state/counts; no session/lease secrets', undefined, [pathId]) },
  '/csv-imports/{id}/rows': { get: operation('commercialImportRows', 'CsvImportRow', 'Complete preview only; current branch authorization, staged rows expire after 30 days', undefined, [pathId, query('page', queryProperties.page), query('limit', queryProperties.limit), query('status', { type: 'string', enum: ['VALID', 'REJECTED', 'DUPLICATE', 'IMPORTED'] })], true) },
  '/csv-imports/{id}/confirm': { post: operation('commercialCommitImport', 'CsvImport', 'Queue confirmed commit to eligible caller; same-assignee failed commit can resume', 'CsvImportConfirm', [pathId], false, '202') },
  '/leads/exports': { post: operation('commercialExport', 'LeadExportJob', 'leads:export intersected with leads:read; background private CSV, max 5000 rows/10 MiB', 'LeadExportQuery', [], false, '202') },
  '/leads/exports/{id}': { get: operation('commercialExportJob', 'LeadExportJob', 'Export creator only, live leads:export grant', undefined, [pathId]) },
  '/leads/exports/{id}/download': { get: operation('commercialExportDownload', 'PhotoDownload', 'Creator and every exported lead reauthorized before version-pinned URL', undefined, [pathId]) },
};
