import type { OpenAPIV3 } from 'openapi-types';

const panelHeader: OpenAPIV3.ParameterObject = { name: 'X-Employee-Panel', in: 'header', required: true,
  schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' }, description: 'Tab-local opaque panel token; also requires the original manager bearer session.' };
const result: OpenAPIV3.ResponsesObject = { '200': { description: 'Operation completed; all responses are no-store' },
  '401': { description: 'Original manager login is invalid' }, '403': { description: 'Not a permitted active downline, expired panel, or restricted action' } };
export const employeePanelPaths: OpenAPIV3.PathsObject = {
  '/auth/employee-panels/{id}/availability': { get: { operationId: 'employeePanelAvailability', tags: ['Authentication'], security: [{ bearerAuth: [] }],
    summary: 'Whether a manager may open this active downline employee panel',
    parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } }], responses: result } },
  '/auth/employee-panels/start': { post: { operationId: 'startEmployeePanel', tags: ['Authentication'], security: [{ bearerAuth: [] }],
    summary: 'Start an audited 30-minute employee panel without replacing manager credentials',
    description: 'Requires users:open_panel and a current reporting path. No self, ancestor, peer, administrator, or nested panel access. Returns data.panelToken and data.expiresAt. Never stores or returns employee credentials. Ordinary work actions use employee permissions; attendance capture and account-security changes are blocked. Every business transaction rechecks manager authority.',
    requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['employeeId'], additionalProperties: false,
      properties: { employeeId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } } } } } }, responses: result } },
  '/auth/employee-panels/stop': { post: { operationId: 'stopEmployeePanel', tags: ['Authentication'], security: [{ bearerAuth: [] }],
    summary: 'Revoke the panel and return to the original manager account, including after expiry or lost downline access',
    parameters: [panelHeader], responses: result } },
};
