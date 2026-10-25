import type { OpenAPIV3 } from 'openapi-types';
import { CALL_OUTCOMES, INTEREST, VISIT_OUTCOMES } from './report.model.js';
const id: OpenAPIV3.SchemaObject = { type: 'string', pattern: '^[a-f0-9]{24}$' };
const time: OpenAPIV3.SchemaObject = { type: 'string', format: 'date-time' };
const revision: OpenAPIV3.SchemaObject = { type: 'integer', minimum: 0 };
const decimal: OpenAPIV3.SchemaObject = { type: 'string', pattern: '^(0|[1-9][0-9]{0,7})(\\.[0-9]{1,2})?$' };
const interest: OpenAPIV3.SchemaObject = { type: 'string', enum: [...INTEREST] };
const ref = (name: string): OpenAPIV3.ReferenceObject => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject>, required: string[] = []): OpenAPIV3.SchemaObject => ({ type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) });
const location = object({ latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 }, accuracyMeters: { type: 'number', minimum: 0, maximum: 100000 } }, ['latitude', 'longitude']);
export const reportSchemas: Record<string, OpenAPIV3.SchemaObject> = {
  CallContactOption: object({ _id: id, customerName: { type: 'string' } }, ['_id', 'customerName']),
  ReportCallInput: object({ customerId: id, callStartedAt: time, callEndedAt: time, callOutcome: { type: 'string', enum: [...CALL_OUTCOMES], description: 'Single caller-selected outcome. Stored interest is derived: INTERESTED or NOT_INTERESTED for those outcomes, otherwise UNKNOWN.' }, customerInterest: { ...interest, deprecated: true, description: 'Accepted for older clients; ignored. Interest is derived from callOutcome.' }, followUpAt: { ...time, nullable: true }, remarks: { type: 'string', maxLength: 2000 } }, ['customerId', 'callStartedAt', 'callEndedAt', 'callOutcome']),
  ReportVisitInput: object({ leadId: id, location, clientCapturedAt: time }, ['leadId', 'location', 'clientCapturedAt']),
  ReportVisitComplete: object({ revision, photoFileIds: { type: 'array', items: id, minItems: 1, maxItems: 5, uniqueItems: true }, location, clientCapturedAt: time,
    discussionNotes: { type: 'string', minLength: 3, maxLength: 4000 }, customerInterest: interest, installationReadiness: { type: 'string', enum: ['UNKNOWN', 'READY', 'NOT_READY'] },
    visitOutcome: { type: 'string', enum: [...VISIT_OUTCOMES] }, requiredCapacityKw: decimal, nextFollowUpAt: { ...time, nullable: true } },
  ['revision', 'photoFileIds', 'location', 'clientCapturedAt', 'discussionNotes', 'customerInterest', 'installationReadiness', 'visitOutcome', 'requiredCapacityKw']),
  ReportReview: object({ revision, reviewStatus: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'] }, remarks: { type: 'string', minLength: 3, maxLength: 500 } }, ['revision', 'reviewStatus', 'remarks']),
  VisitPhotoUpload: object({ filename: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}\\.(jpg|jpeg|png|webp)$' }, contentType: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp'] }, size: { type: 'integer', minimum: 12, maximum: 5242880 }, checksumSHA256: { type: 'string', pattern: '^[A-Za-z0-9+/]{43}=$' } }, ['filename', 'contentType', 'size', 'checksumSHA256']),
  ReportActivity: { type: 'object', properties: { _id: id, kind: { type: 'string', enum: ['CALL', 'VISIT'] }, employeeId: id, employeeName: { type: 'string', nullable: true, description: 'Caller name included in scoped report lists; null if the employee no longer exists' }, salesExecutiveId: { ...id, nullable: true }, branchId: id, customerId: { ...id, nullable: true }, leadId: { ...id, nullable: true },
    businessDate: { type: 'string', format: 'date' }, customerName: { type: 'string' }, customerMobile: { type: 'string' }, siteAddress: { type: 'string' },
    callStartedAt: time, callEndedAt: time, callDurationSeconds: { type: 'integer', minimum: 0 }, callOutcome: { type: 'string', enum: [...CALL_OUTCOMES] }, customerInterest: interest, followUpAt: { ...time, nullable: true }, remarks: { type: 'string' }, convertedToLead: { type: 'boolean', description: 'Customer already linked to a lead at call submission; never a conversion count' },
    visitDate: { type: 'string', format: 'date' }, visitStartedAt: time, visitCompletedAt: { ...time, nullable: true }, clientCapturedAt: time, completedCapturedAt: time, startLocation: location, location,
    point: object({ type: { type: 'string', enum: ['Point'] }, coordinates: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2, description: '[longitude, latitude]' } }),
    photoFileIds: { type: 'array', items: id }, evidenceFlags: { type: 'array', items: { type: 'string' } }, requiredCapacityKw: { ...decimal, nullable: true }, ratePerKw: { ...decimal, nullable: true }, estimatedProjectValue: { type: 'string', nullable: true },
    installationReadiness: { type: 'string' }, discussionNotes: { type: 'string' }, nextFollowUpAt: { ...time, nullable: true }, visitOutcome: { type: 'string', enum: [...VISIT_OUTCOMES] },
    status: { type: 'string', enum: ['OPEN', 'SUBMITTED', 'EXPIRED'] }, reviewStatus: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'] }, reviewedBy: { ...id, nullable: true }, reviewedAt: { ...time, nullable: true }, reviewRemarks: { type: 'string' }, revision, createdAt: time, updatedAt: time,
  } },
  ReportHistory: object({ _id: id, reportId: id, actorId: id, action: { type: 'string', enum: ['CREATED', 'SUBMITTED', 'REVIEWED', 'EXPIRED'] }, revision, before: { type: 'string' }, after: { type: 'string' }, remarks: { type: 'string' }, createdAt: time }),
  ReportDaily: object({ timezone: { type: 'string', enum: ['Asia/Kolkata'] }, days: { type: 'array', items: object({ _id: object({ date: { type: 'string', format: 'date' }, employeeId: id }),
    totalCalls: { type: 'integer' }, callDurationSeconds: { type: 'integer' }, approvedCalls: { type: 'integer' }, approvedDurationSeconds: { type: 'integer' }, interestedCalls: { type: 'integer' },
    outcomeCounts: object(Object.fromEntries(CALL_OUTCOMES.map((outcome) => [outcome, { type: 'integer' as const, minimum: 0 }]))) }) } }),
};
const query = (name: string, schema: OpenAPIV3.SchemaObject): OpenAPIV3.ParameterObject => ({ in: 'query', name, schema });
const filters = ['employeeId', 'customerId', 'leadId', 'branchId'].map((name) => query(name, id)).concat([
  query('from', { type: 'string', format: 'date', description: 'Inclusive Kolkata business date' }), query('to', { type: 'string', format: 'date' }),
  query('reviewStatus', { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'] }), query('callOutcome', { type: 'string', enum: [...CALL_OUTCOMES] }), query('visitOutcome', { type: 'string', enum: [...VISIT_OUTCOMES] }),
  query('page', { type: 'integer', minimum: 1, maximum: 10000, default: 1 }), query('limit', { type: 'integer', minimum: 1, maximum: 100, default: 20 }), query('sortOrder', { type: 'string', enum: ['asc', 'desc'], default: 'desc' }),
]);
const pathId: OpenAPIV3.ParameterObject = { in: 'path', name: 'id', required: true, schema: id };
const fileId: OpenAPIV3.ParameterObject = { in: 'path', name: 'fileId', required: true, schema: id };
const key: OpenAPIV3.ParameterObject = { in: 'header', name: 'Idempotency-Key', required: true, schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{16,100}$' } };
const operation = (operationId: string, summary: string, output: string, input?: string, parameters: OpenAPIV3.ParameterObject[] = [], list = false, status = '200'): OpenAPIV3.OperationObject => ({ operationId, summary, tags: ['Reports'], security: [{ bearerAuth: [] }], parameters,
  ...(input ? { requestBody: { required: true, content: { 'application/json': { schema: ref(input) } } } } : {}),
  responses: { [status]: { description: 'Successful operation', content: { 'application/json': { schema: object({ success: { type: 'boolean' }, message: { type: 'string' }, data: list ? { type: 'array', items: ref(output) } : ref(output), meta: { type: 'object' } }) } } },
    ...Object.fromEntries(['400', '401', '403', '404', '409', '429', '500', '503'].map((code) => [code, { description: 'Rejected; see error.code', content: { 'application/json': { schema: ref('ErrorResponse') } } }])),
  },
});
export const reportPaths: OpenAPIV3.PathsObject = {
  '/telecaller-reports/contact-options': { get: operation('reportCallContactOptions', 'reports:create and customers:read; only Available or Interested assigned contacts belonging to the caller or within authorized report-review and contact-read scope', 'CallContactOption', undefined, [query('page', { type: 'integer', minimum: 1, maximum: 10000, default: 1 }), query('limit', { type: 'integer', minimum: 1, maximum: 100, default: 20 }), query('search', { type: 'string', minLength: 2, maxLength: 150 })], true) },
  '/telecaller-reports/calls': { post: operation('reportCallCreate', 'reports:create; Available or Interested assigned contact within caller or authorized management scope; authenticated caller identity and server-derived duration. INTERESTED outcome atomically marks an Available contact INTERESTED with revision and audit; other outcomes preserve contact status.', 'ReportActivity', 'ReportCallInput', [key], false, '201') },
  '/telecaller-reports/daily': { get: operation('reportCallDaily', 'Scoped calls grouped by Kolkata date/employee; submitted and approved totals', 'ReportDaily', undefined, filters) },
  '/sales-reports/visits': { post: operation('reportVisitStart', 'reports:create; current assigned eligible lead; server-timed start', 'ReportActivity', 'ReportVisitInput', [key], false, '201') },
  '/sales-reports/visits/{id}/complete': { patch: operation('reportVisitComplete', 'Complete own open visit within 24 hours; current assignment and 1-5 fresh photos', 'ReportActivity', 'ReportVisitComplete', [pathId]) },
  '/sales-reports/visits/{id}/photos/upload-intents': { post: operation('reportVisitPhotoIntent', 'Private parent-bound photo upload; reports:create + files:upload', 'PhotoUploadIntent', 'VisitPhotoUpload', [pathId], false, '201') },
  '/sales-reports/visits/{id}/photos/{fileId}/confirm': { post: operation('reportVisitPhotoConfirm', 'Verify exact checksum/type/size and immutable S3 version', 'PhotoFile', undefined, [pathId, fileId]) },
  '/sales-reports/visits/{id}/photos/{fileId}/download': { get: operation('reportVisitPhotoDownload', 'Parent reports:read scope; 60 second version-bound URL', 'PhotoDownload', undefined, [pathId, fileId]) },
};
for (const [path, prefix] of [['telecaller-reports/calls', 'reportCall'], ['sales-reports/visits', 'reportVisit']] as const) {
  const existing = reportPaths[`/${path}`];
  reportPaths[`/${path}`] = { ...existing, get: operation(`${prefix}List`, 'reports:read scoped history and filters', 'ReportActivity', undefined, filters, true) };
  reportPaths[`/${path}/{id}`] = { get: operation(`${prefix}Get`, 'reports:read scoped record', 'ReportActivity', undefined, [pathId]) };
  reportPaths[`/${path}/{id}/history`] = { get: operation(`${prefix}History`, 'Parent-scoped append-only report history', 'ReportHistory', undefined, [pathId, ...filters], true) };
  reportPaths[`/${path}/{id}/review`] = { patch: operation(`${prefix}Review`, 'reports:review; revision checked; no self review or open-visit review', 'ReportActivity', 'ReportReview', [pathId]) };
}
