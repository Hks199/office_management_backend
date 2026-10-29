import type { OpenAPIV3 } from 'openapi-types';
import { DASHBOARD_KINDS } from './dashboard.types.js';
import { LEAD_STATUSES } from '../leads/commercial.models.js';
import { TARGET_TYPES } from '../targets/target.types.js';
const id: OpenAPIV3.SchemaObject = { type: 'string', pattern: '^[a-f0-9]{24}$' };
const day: OpenAPIV3.SchemaObject = { type: 'string', format: 'date', pattern: '^20[0-9]{2}-[0-9]{2}-[0-9]{2}$' };
const time: OpenAPIV3.SchemaObject = { type: 'string', format: 'date-time' };
const number: OpenAPIV3.SchemaObject = { type: 'integer', minimum: 0 };
const decimal: OpenAPIV3.SchemaObject = { type: 'string', description: 'Exact decimal text; never converted through floating point' };
const ref = (name: string): OpenAPIV3.ReferenceObject => ({ $ref: `#/components/schemas/${name}` });
const input = (properties: Record<string, OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject>, required: string[] = []): OpenAPIV3.SchemaObject => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const output = (properties: Record<string, OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject>): OpenAPIV3.SchemaObject => ({ type: 'object', properties });
const queryProperties: Record<string, OpenAPIV3.SchemaObject> = {
  startDate: { ...day, description: 'Inclusive Kolkata date; defaults to current month start' }, endDate: { ...day, description: 'Exclusive Kolkata date; defaults to tomorrow; 1-366 day window' },
  ...Object.fromEntries(['branchId', 'employeeId', 'managerId', 'roleId', 'stateId', 'districtId', 'blockId'].map((key) => [key, id])),
  search: { type: 'string', minLength: 2, maxLength: 100, description: 'Literal employee name/code prefix; requires users:read' },
  leadStatus: { type: 'array', uniqueItems: true, maxItems: LEAD_STATUSES.length, items: { type: 'string', enum: [...LEAD_STATUSES] } }, leadSource: { type: 'string', pattern: '^[A-Z0-9_-]{1,32}$' }, targetType: { type: 'string', enum: [...TARGET_TYPES] },
  compare: { type: 'boolean', default: true, description: 'Trends compare the immediately previous equal elapsed interval with the same source scope' },
  page: { type: 'integer', minimum: 1, maximum: 10000, default: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  sortBy: { type: 'string', enum: ['approvedCalls', 'approvedVisits', 'approvedConversions', 'salesValue', 'name'], default: 'approvedConversions' }, sortOrder: { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
};
const metricProperties = Object.fromEntries(['submittedCalls', 'approvedCalls', 'connectedCalls', 'submittedVisits', 'approvedVisits', 'pendingReports', 'rejectedReports', 'callDurationSeconds', 'generatedLeads', 'qualifiedLeads', 'approvedConversions', 'employeeCount', 'currentAssignedCustomers', 'currentAssignedLeads', 'approvedAttendanceRecords', 'activeTargetCount'].map((key) => [key, { ...number, nullable: true }]));
const window = output({ start: time, end: time });
const counts = { type: 'array' as const, items: output({ _id: { type: 'string', nullable: true }, count: number }) };
export const dashboardSchemas: Record<string, OpenAPIV3.SchemaObject> = {
  DashboardQuery: input(queryProperties),
  DashboardSnapshot: output({ kind: { type: 'string', enum: [...DASHBOARD_KINDS] }, timezone: { type: 'string', enum: ['Asia/Kolkata'] }, asOf: time,
    requestedPeriod: input({ startDate: day, endDate: day }), data: { type: 'object', description: 'Scoped module payload; see PHASE8.md for endpoint-specific semantics and bounds', properties: {
      available: { type: 'boolean' }, period: window, actualIsScoped: { type: 'boolean', enum: [true] }, total: number, page: number, limit: number,
      rows: { type: 'array', items: { type: 'object', description: 'Performance/target/trend rows, according to kind' } },
      employees: output({ available: { type: 'boolean' }, total: number, active: number }), branches: output({ available: { type: 'boolean' }, total: number }),
      customers: output({ available: { type: 'boolean' }, created: number, statuses: counts }),
      activities: output({ available: { type: 'boolean' }, ...metricProperties, outcomes: counts, recent: { type: 'array', items: { type: 'object' } } }),
      sales: output({ available: { type: 'boolean' }, ...metricProperties, salesValue: decimal, approvedOnly: { type: 'boolean' } }),
      leads: ref('DashboardLeads'), attendance: output({ available: { type: 'boolean' }, days: { type: 'array', items: { type: 'object' } }, absence: ref('DashboardAbsence') }),
      absence: ref('DashboardAbsence'), imports: output({ available: { type: 'boolean' }, statuses: { type: 'array', items: { type: 'object' } } }),
      topEmployees: ref('DashboardPerformance'), financialMetricsAvailable: { type: 'boolean' }, previous: { ...output({ window, rows: { type: 'array', items: { type: 'object' } } }), nullable: true },
    } },
  }),
  DashboardPerformance: output({ available: { type: 'boolean' }, rows: { type: 'array', items: output({ id, name: { type: 'string' }, employeeCode: { type: 'string' }, roleId: id, ...metricProperties, salesValue: { ...decimal, nullable: true } }) }, total: number, page: number, limit: number,
    financialMetricsAvailable: { type: 'boolean' }, rankingUsesApprovedActivity: { type: 'boolean' }, roleAttribution: { type: 'string', enum: ['CURRENT_EMPLOYEE_ROLE'] }, effectiveSortBy: { type: 'string' } }),
  DashboardLeads: output({ available: { type: 'boolean' }, totalLeads: number, convertedLeads: number, pendingLeads: number, currentStatusFunnel: counts, createdInPeriod: number, createdCohortCurrentStatuses: counts, cohortConversionPercentage: decimal, followUps: counts, cohortIsVerifiedPerformance: { type: 'boolean', enum: [false] } }),
  DashboardAbsence: output({ available: { type: 'boolean' }, reason: { type: 'string' }, date: day, eligibleEmployees: number, employeesWithVisibleCheckIn: number, absentEmployees: { ...number, nullable: true }, unconfiguredEmployees: number, absenceIsProvisional: { type: 'boolean', enum: [true] }, definition: { type: 'string' } }),
  DashboardCalendarInput: input({ revision: number, workingWeekdays: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, minItems: 1, maxItems: 7, uniqueItems: true }, holidays: { type: 'array', items: day, maxItems: 366, uniqueItems: true } }, ['revision', 'workingWeekdays', 'holidays']),
  DashboardCalendar: output({ _id: id, branchId: id, configured: { type: 'boolean' }, revision: number, workingWeekdays: { type: 'array', items: { type: 'integer' } }, holidays: { type: 'array', items: day }, changedBy: id, createdAt: time, updatedAt: time }),
  DashboardExportInput: input({ kind: { type: 'string', enum: [...DASHBOARD_KINDS] }, query: ref('DashboardQuery') }, ['kind', 'query']),
  DashboardExportJob: output({ _id: id, createdBy: id, kind: { type: 'string', enum: [...DASHBOARD_KINDS] }, status: { type: 'string', enum: ['QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED'] }, asOf: { ...time, nullable: true }, fileId: { ...id, nullable: true }, attempts: number, errorCode: { type: 'string' }, requestId: { type: 'string' }, expiresAt: time, createdAt: time, updatedAt: time }),
};
const filterParams: OpenAPIV3.ParameterObject[] = Object.entries(queryProperties).map(([name, schema]) => ({ in: 'query', name, schema, ...(name === 'leadStatus' ? { style: 'form' as const, explode: true } : {}) }));
const pathId: OpenAPIV3.ParameterObject = { in: 'path', name: 'id', required: true, schema: id };
const operation = (operationId: string, summary: string, result: string, body?: string, parameters: OpenAPIV3.ParameterObject[] = [], status = '200'): OpenAPIV3.OperationObject => ({
  operationId, summary, tags: ['Dashboards'], security: [{ bearerAuth: [] }], parameters,
  ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: ref(body) } } } } : {}),
  responses: { [status]: { description: 'Successful operation', content: { 'application/json': { schema: output({ success: { type: 'boolean' }, message: { type: 'string' }, data: ref(result) }) } } },
    ...Object.fromEntries(['400', '401', '403', '404', '409', '422', '429', '500', '503'].map((code) => [code, { description: 'Rejected; see error.code', content: { 'application/json': { schema: ref('ErrorResponse') } } }])),
  },
});
export const dashboardPaths: OpenAPIV3.PathsObject = {};
for (const kind of DASHBOARD_KINDS) dashboardPaths[`/dashboard/${kind}`] = { get: operation(`dashboard_${kind.replaceAll('-', '_')}`, `dashboard:read intersected with each source grant; ${kind}; no role-name switches`, 'DashboardSnapshot', undefined, filterParams) };
dashboardPaths['/dashboard/exports'] = { post: operation('dashboardExportCreate', 'Queue owner-bound private metric/value CSV; dashboard:export + dashboard:read; source scopes rechecked by worker', 'DashboardExportJob', 'DashboardExportInput', [], '202') };
dashboardPaths['/dashboard/exports/{id}'] = { get: operation('dashboardExportGet', 'Read own unexpired job; private query/principal/fingerprint excluded', 'DashboardExportJob', undefined, [pathId]) };
dashboardPaths['/dashboard/exports/{id}/download'] = { get: operation('dashboardExportDownload', 'Regenerate same-asOf metrics under current grants; deny stale/revoked data; 60 second version-bound URL', 'PhotoDownload', undefined, [pathId]) };
dashboardPaths['/dashboard/attendance-calendars/{id}'] = {
  get: operation('dashboardCalendarGet', 'MD only: branch working calendar; unconfigured calendars are explicit', 'DashboardCalendar', undefined, [pathId]),
  put: operation('dashboardCalendarSet', 'MD only, no employee panels; settings:manage ALL + visible branch + dashboard scope; expected revision; Monday=1 through Sunday=7', 'DashboardCalendar', 'DashboardCalendarInput', [pathId]),
};
