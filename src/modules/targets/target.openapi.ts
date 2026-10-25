import type { OpenAPIV3 } from 'openapi-types';
import { TARGET_TYPES, PERIOD_TYPES } from './target.types.js';
const id: OpenAPIV3.SchemaObject = { type: 'string', pattern: '^[a-f0-9]{24}$' };
const day: OpenAPIV3.SchemaObject = { type: 'string', format: 'date', description: 'Kolkata calendar date; endDate/to is exclusive' };
const time: OpenAPIV3.SchemaObject = { type: 'string', format: 'date-time' };
const decimal: OpenAPIV3.SchemaObject = { type: 'string', pattern: '^(0|[1-9][0-9]{0,15})(\\.[0-9]{1,2})?$' };
const revision: OpenAPIV3.SchemaObject = { type: 'integer', minimum: 0 };
const type: OpenAPIV3.SchemaObject = { type: 'string', enum: [...TARGET_TYPES] };
const period: OpenAPIV3.SchemaObject = { type: 'string', enum: [...PERIOD_TYPES] };
const status: OpenAPIV3.SchemaObject = { type: 'string', enum: ['ACTIVE', 'CANCELLED'] };
const review: OpenAPIV3.SchemaObject = { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'] };
const milestone: OpenAPIV3.SchemaObject = { type: 'string', enum: ['CREATED', 'QUALIFIED', 'CONVERTED'] };
const reason: OpenAPIV3.SchemaObject = { type: 'string', minLength: 3, maxLength: 500 };
const ref = (name: string): OpenAPIV3.ReferenceObject => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject>, required: string[] = []): OpenAPIV3.SchemaObject => ({ type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) });
const definition = { employeeId: id, targetType: type, targetValue: decimal, periodType: period, startDate: day, endDate: day };
const targetProperties = { ...definition, _id: id, startDate: time, endDate: time, businessStartDate: day, businessEndDate: day, timezone: { type: 'string' as const, enum: ['Asia/Kolkata'] }, branchId: id, assignedBy: id, employeeName: { type: 'string' as const, nullable: true }, employeeCode: { type: 'string' as const, nullable: true }, assignedByName: { type: 'string' as const, nullable: true }, assignedByCode: { type: 'string' as const, nullable: true }, status, revision, createdAt: time, updatedAt: time };
const metrics = { actualValue: { type: 'string' as const, description: 'Exact decimal string; approved activity only, intersected with current source grants' }, achievementPercentage: { type: 'string' as const, description: 'Exact decimal percentage rounded half-up to two digits; uncapped; zero for zero target' }, asOf: time, actualIsScoped: { type: 'boolean' as const, enum: [true] }, verifiedOnly: { type: 'boolean' as const, enum: [true] } };
export const targetSchemas: Record<string, OpenAPIV3.SchemaObject> = {
  TargetCreate: object(definition, ['employeeId', 'targetType', 'targetValue', 'periodType', 'startDate', 'endDate']),
  TargetUpdate: object({ revision, targetValue: decimal, startDate: day, endDate: day, status, reason }, ['revision', 'reason']),
  Target: object(targetProperties), TargetProgress: object({ ...targetProperties, ...metrics }),
  TargetRevision: { type: 'object', properties: { ...targetProperties, targetId: id, changedBy: id, reason } },
  TargetMetricsReport: object({ rows: { type: 'array', items: ref('TargetProgress') }, ...metrics, timezone: { type: 'string', enum: ['Asia/Kolkata'] } }),
  TargetSummary: object({ rows: { type: 'array', items: object({ branchId: id, targetType: type, periodType: period, startDate: time, endDate: time, targetValue: { type: 'string' },
    actualValue: metrics.actualValue, achievementPercentage: metrics.achievementPercentage, targetCount: { type: 'integer' }, employeeCount: { type: 'integer' } }) }, asOf: time, actualIsScoped: metrics.actualIsScoped, verifiedOnly: metrics.verifiedOnly, timezone: { type: 'string', enum: ['Asia/Kolkata'] } }),
  TargetEvidence: object({ _id: id, leadId: id, sourceEventId: id, milestone, employeeId: id, branchId: id, createdBy: id, assignedTo: { ...id, nullable: true }, performedBy: id,
    occurredAt: time, valueAtConversion: { type: 'string', nullable: true }, reviewStatus: review, revision, reviewedBy: { ...id, nullable: true }, reviewedAt: { ...time, nullable: true }, remarks: { type: 'string' }, createdAt: time, updatedAt: time }),
  TargetEvidenceReview: object({ revision, reviewStatus: review, remarks: reason }, ['revision', 'reviewStatus', 'remarks']),
  TargetEvidenceCapture: object({ milestone }, ['milestone']),
  TargetEvidenceHistory: object({ _id: id, evidenceId: id, actorId: id, revision, before: review, after: review, remarks: reason, createdAt: time }),
};
const param = (name: string, schema: OpenAPIV3.SchemaObject): OpenAPIV3.ParameterObject => ({ in: 'query', name, schema });
const pages = [param('page', { type: 'integer', minimum: 1, maximum: 10000, default: 1 }), param('limit', { type: 'integer', minimum: 1, maximum: 100, default: 20 }), param('sortOrder', { type: 'string', enum: ['asc', 'desc'], default: 'desc' })];
const filters = [param('employeeId', id), param('branchId', id), param('targetType', type), param('periodType', period), param('status', { ...status, default: 'ACTIVE' }), param('from', day), param('to', day), ...pages];
const evidenceFilters = [param('employeeId', id), param('branchId', id), param('leadId', id), param('milestone', milestone), param('reviewStatus', review), ...pages];
const pathId: OpenAPIV3.ParameterObject = { in: 'path', name: 'id', required: true, schema: id };
const operation = (operationId: string, summary: string, output: string, input?: string, parameters: OpenAPIV3.ParameterObject[] = [], list = false, code = '200'): OpenAPIV3.OperationObject => ({ operationId, summary, tags: ['Targets'], security: [{ bearerAuth: [] }], parameters,
  ...(input ? { requestBody: { required: true, content: { 'application/json': { schema: ref(input) } } } } : {}), responses: {
    [code]: { description: 'Successful operation', content: { 'application/json': { schema: object({ success: { type: 'boolean' }, message: { type: 'string' }, data: list ? { type: 'array', items: ref(output) } : ref(output), meta: { type: 'object' } }) } } },
    ...Object.fromEntries(['400', '401', '403', '404', '409', '422', '429', '500', '503'].map((status) => [status, { description: 'Rejected; see error.code', content: { 'application/json': { schema: ref('ErrorResponse') } } }])),
  },
});
export const targetPaths: OpenAPIV3.PathsObject = {
  '/targets': { post: operation('targetCreate', 'targets:create; current active eligible employee in authorized scope; server branch/assigner; same-period overlap protection', 'Target', 'TargetCreate', [], false, '201'), get: operation('targetList', 'targets:read scoped definitions', 'Target', undefined, filters, true) },
  '/targets/summary': { get: operation('targetSummary', 'Scope-first compatible-goal groups; at most 500 matching definitions; current source grants required', 'TargetSummary', undefined, filters) },
  '/targets/reports': { get: operation('targetReport', 'Paginated target report with approved actuals and exact uncapped percentages', 'TargetMetricsReport', undefined, filters) },
  '/targets/{id}': { get: operation('targetGet', 'targets:read scoped definition', 'Target', undefined, [pathId]), patch: operation('targetUpdate', 'targets:update; current source/destination scope, expected revision and reason; append full historical definition', 'Target', 'TargetUpdate', [pathId]) },
  '/targets/{id}/progress': { get: operation('targetProgress', 'targets:read + reports:read; lead milestones also require leads:read; approved, half-open, snapshot-attributed actuals', 'TargetProgress', undefined, [pathId]) },
  '/targets/{id}/revisions': { get: operation('targetRevisions', 'Parent-scoped immutable target definitions, latest revision first', 'TargetRevision', undefined, [pathId, ...pages], true) },
  '/target-evidence': { get: operation('targetEvidenceList', 'reports:read and leads:read intersected on historical milestone attribution', 'TargetEvidence', undefined, evidenceFilters, true) },
  '/target-evidence/leads/{id}/capture': { post: operation('targetEvidenceCapture', 'Capture legacy first milestone as PENDING from original event and assignment revisions; reports:review + lead visibility', 'TargetEvidence', 'TargetEvidenceCapture', [pathId]) },
  '/target-evidence/{id}/review': { patch: operation('targetEvidenceReview', 'Scoped independent verification; no performer/credited-employee self approval; frozen conversion value required', 'TargetEvidence', 'TargetEvidenceReview', [pathId]) },
  '/target-evidence/{id}/history': { get: operation('targetEvidenceHistory', 'Parent-scoped immutable verification history', 'TargetEvidenceHistory', undefined, [pathId, ...pages], true) },
};
