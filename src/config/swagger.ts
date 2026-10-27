import type { OpenAPIV3 } from 'openapi-types';
import { identityPaths, identitySchemas } from '../modules/auth/auth.openapi.js';
import { employeePanelPaths } from '../modules/auth/employee-panel.openapi.js';
import { organizationPaths, organizationSchemas } from '../modules/hierarchy/organization.openapi.js';
import { attendancePaths, attendanceSchemas } from '../modules/attendance/attendance.openapi.js';
import { commercialPaths, commercialSchemas } from '../modules/leads/commercial.openapi.js';
import { reportPaths, reportSchemas } from '../modules/reports/report.openapi.js';
import { targetPaths, targetSchemas } from '../modules/targets/target.openapi.js';
import { dashboardPaths, dashboardSchemas } from '../modules/dashboards/dashboard.openapi.js';

const successSchema: OpenAPIV3.SchemaObject = {
  type: 'object', required: ['success', 'message', 'data'],
  properties: {
    success: { type: 'boolean', enum: [true] }, message: { type: 'string' },
    data: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } },
  },
};

export const openApiDocument: OpenAPIV3.Document = {
  openapi: '3.0.3',
  info: {
    title: 'Sunvika Office Management API', version: '0.9.0',
    description: 'Phase 1-9 runtime endpoints. See PHASE9.md for production operations and verification boundaries.',
  },
  servers: [{ url: '/api/v1' }],
  tags: [{ name: 'Health', description: 'Minimal operational health signals' }, { name: 'Authentication' }, { name: 'Roles' }, { name: 'Employees' }, { name: 'Branches' }, { name: 'Locations' }, { name: 'Attendance' }, { name: 'Files' }, { name: 'Reports' }, { name: 'Targets' }, { name: 'Dashboards' }],
  paths: {
    '/display-references': { post: {
      operationId: 'resolveDisplayReferences', tags: ['References'], summary: 'Resolve at most 100 references to names/codes using each resource\'s existing read scope',
      description: 'Missing and unauthorized records are omitted. Only minimal name/code metadata is returned; no profiles, contact details, file locations or credentials. No-store.',
      security: [{ bearerAuth: [] }],
      requestBody: { required: true, content: { 'application/json': { schema: {
        type: 'object', required: ['references'], additionalProperties: false, properties: { references: { type: 'array', minItems: 1, maxItems: 100, items: {
          type: 'object', required: ['kind', 'id'], additionalProperties: false, properties: {
            kind: { type: 'string', enum: ['employee', 'branch', 'role', 'permission', 'state', 'district', 'block', 'contact', 'lead', 'report', 'target', 'file'] },
            id: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
          },
        } } },
      } } } },
      responses: {
        '200': { description: 'Scoped name/code references', content: { 'application/json': { schema: {
          type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' }, data: { type: 'array', items: {
            type: 'object', properties: { kind: { type: 'string' }, id: { type: 'string' }, name: { type: 'string' }, code: { type: 'string' } },
          } } },
        } } } },
        '400': { description: 'Invalid reference kind, identifier or batch size' }, '401': { description: 'Authentication required' },
      },
    } },
    '/operations/metrics': { get: {
      operationId: 'getOperationalMetrics', tags: ['Operations'], summary: 'Live settings:manage ALL only: process telemetry and queue status/oldest creation time',
      description: 'No query parameters. Process counters reset on restart; queue aggregates are shared. Excludes credentials, customer data, payloads and storage metadata. No-store.',
      security: [{ bearerAuth: [] }], responses: {
        '200': { description: 'Operational snapshot', content: { 'application/json': { schema: {
          type: 'object', required: ['success', 'message', 'data'], properties: {
            success: { type: 'boolean', enum: [true] }, message: { type: 'string' }, data: { type: 'object', required: ['observedAt', 'http', 'database', 'queues'], properties: {
              observedAt: { type: 'string', format: 'date-time' }, http: { type: 'object' }, database: { type: 'object' }, queues: { type: 'object' },
            } },
          },
        } } } },
        '400': { description: 'Unknown query parameter' }, '401': { description: 'Authentication required' },
        '403': { description: 'Requires current settings:manage ALL' }, '503': { description: 'Service unavailable' },
      },
    } },
    ...identityPaths,
    ...employeePanelPaths,
    ...organizationPaths,
    ...attendancePaths,
    ...commercialPaths,
    ...reportPaths,
    ...targetPaths,
    ...dashboardPaths,
    '/health/live': { get: {
      operationId: 'getLiveness', tags: ['Health'], summary: 'Process liveness', security: [],
      responses: { '200': { description: 'Process is alive', content: { 'application/json': { schema: successSchema } } } },
    } },
    '/health/ready': { get: {
      operationId: 'getReadiness', tags: ['Health'], summary: 'Database readiness', security: [],
      responses: {
        '200': { description: 'Database is reachable', content: { 'application/json': { schema: successSchema } } },
        '503': { description: 'Database unavailable or service draining', content: {
          'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } },
        } },
      },
    } },
  },
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    refreshCookie: { type: 'apiKey', in: 'cookie', name: 'sunvika_refresh' } }, schemas: {
    ...identitySchemas,
    ...organizationSchemas,
    ...attendanceSchemas,
    ...commercialSchemas,
    ...reportSchemas,
    ...targetSchemas,
    ...dashboardSchemas,
    ErrorResponse: {
      type: 'object', required: ['success', 'message', 'error'],
      properties: {
        success: { type: 'boolean', enum: [false] }, message: { type: 'string' },
        error: { type: 'object', required: ['code', 'details'], properties: {
          code: { type: 'string' }, details: { type: 'array', items: {
            type: 'object', properties: { field: { type: 'string' }, code: { type: 'string' } },
          } },
        } },
      },
    },
  } },
};
