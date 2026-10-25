import type { OpenAPIV3 } from 'openapi-types';
import { DATA_SCOPES } from '../../constants/permissions.js';

const ref = (name: string): OpenAPIV3.ReferenceObject => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject) => ({ 'application/json': { schema } });
const body = (name: string): OpenAPIV3.RequestBodyObject => ({ required: true, content: json(ref(name)) });
const bearer = [{ bearerAuth: [] }];
const cookie = [{ refreshCookie: [] }];
const responses = (description: string, status = '200', schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject = ref('SuccessResponse')): OpenAPIV3.ResponsesObject => ({
  [status]: { description, content: json(schema) },
  ...Object.fromEntries(['400', '401', '403', '404', '409', '429', '500', '503'].map((code) => [code, { description: 'Request rejected; see error.code', content: json(ref('ErrorResponse')) }])),
});
const id: OpenAPIV3.ParameterObject = { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } };
const csrf: OpenAPIV3.ParameterObject[] = [{ name: 'Origin', in: 'header', required: true, schema: { type: 'string', format: 'uri' } },
  { name: 'X-CSRF-Token', in: 'header', required: true, schema: { type: 'string', minLength: 43, maxLength: 43 } }];
const pagination: OpenAPIV3.ParameterObject[] = [
  { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 10000, default: 1 } },
  { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
  { name: 'sortBy', in: 'query', schema: { type: 'string', enum: ['name', 'createdAt'], default: 'name' } },
  { name: 'sortOrder', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'asc' } },
  { name: 'search', in: 'query', schema: { type: 'string', minLength: 2, maxLength: 100 } },
  { name: 'isActive', in: 'query', schema: { type: 'boolean' } },
];
const policyPagination: OpenAPIV3.ParameterObject[] = [
  ...pagination.filter((parameter) => ['page', 'limit', 'isActive'].includes(parameter.name)),
  { name: 'sortOrder', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
  { name: 'creatorRoleId', in: 'query', schema: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } },
  { name: 'targetRoleId', in: 'query', schema: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } },
];

export const identityPaths: OpenAPIV3.PathsObject = {
  '/auth/login': { post: { tags: ['Authentication'], operationId: 'login', summary: 'Sign in and set HttpOnly refresh cookie',
    security: [], requestBody: body('LoginRequest'), responses: responses('Access token, CSRF token and expiry; refresh token only in cookie', '200', ref('SessionResponse')) } },
  '/auth/refresh': { post: { tags: ['Authentication'], operationId: 'refresh', summary: 'Rotate refresh session; replay revokes the family',
    security: cookie, parameters: csrf, responses: responses('Rotated cookie and access token', '200', ref('SessionResponse')) } },
  '/auth/csrf': { get: { tags: ['Authentication'], operationId: 'getCsrf', summary: 'Recover a CSRF token for a live refresh session',
    security: cookie, parameters: [csrf[0] as OpenAPIV3.ParameterObject], responses: responses('CSRF token') } },
  '/auth/logout': { post: { tags: ['Authentication'], operationId: 'logout', security: cookie, parameters: csrf, responses: responses('Session family revoked; cookie cleared') } },
  '/auth/logout-all': { post: { tags: ['Authentication'], operationId: 'logoutAll', security: bearer, responses: responses('All employee sessions revoked') } },
  '/auth/change-password': { post: { tags: ['Authentication'], operationId: 'changePassword', security: bearer,
    requestBody: body('ChangePasswordRequest'), responses: responses('Password changed; all sessions revoked') } },
  '/auth/forgot-password': { post: { tags: ['Authentication'], operationId: 'forgotPassword', security: [],
    requestBody: body('ForgotPasswordRequest'), responses: responses('Generic response; eligible account delivery queued', '202') } },
  '/auth/reset-password': { post: { tags: ['Authentication'], operationId: 'resetPassword', security: [],
    requestBody: body('ResetPasswordRequest'), responses: responses('Single-use reset consumed; sessions revoked') } },
  '/auth/accept-invitation': { post: { tags: ['Authentication'], operationId: 'acceptInvitation', security: [],
    requestBody: body('ResetPasswordRequest'), responses: responses('Initial password configured') } },
  '/auth/me': { get: { tags: ['Authentication'], operationId: 'getMe', security: bearer, responses: responses('Safe profile and current grants') } },
  '/permissions': { get: { tags: ['Roles'], operationId: 'listPermissions', summary: 'Controlled registry; permissions:read ALL required',
    security: bearer, responses: responses('Available permissions') } },
  '/roles': {
    get: { tags: ['Roles'], operationId: 'listRoles', security: bearer, parameters: pagination, responses: responses('Paginated roles; roles:read ALL required') },
    post: { tags: ['Roles'], operationId: 'createRole', security: bearer, requestBody: body('RoleCreateRequest'), responses: responses('Role created; delegation checks enforced', '201') },
  },
  '/roles/{id}': {
    get: { tags: ['Roles'], operationId: 'getRole', security: bearer, parameters: [id], responses: responses('Role definition') },
    patch: { tags: ['Roles'], operationId: 'updateRole', security: bearer, parameters: [id], requestBody: body('RoleUpdateRequest'), responses: responses('Role updated and audited; grants apply immediately') },
    delete: { tags: ['Roles'], operationId: 'archiveRole', security: bearer, parameters: [id], requestBody: body('RevisionRequest'), responses: responses('Unused custom role archived; system/in-use roles protected') },
  },
  '/role-creation-policies': {
    get: { tags: ['Roles'], operationId: 'listCreationPolicies', security: bearer, parameters: policyPagination, responses: responses('Paginated policy list; policies:manage ALL required') },
    post: { tags: ['Roles'], operationId: 'createPolicy', security: bearer, requestBody: body('PolicyCreateRequest'), responses: responses('Role creation policy created', '201') },
  },
  '/role-creation-policies/{id}': { put: { tags: ['Roles'], operationId: 'updatePolicy', security: bearer,
    parameters: [id], requestBody: body('PolicyUpdateRequest'), responses: responses('Policy replaced using expected revision') } },
};

const email: OpenAPIV3.SchemaObject = { type: 'string', format: 'email', maxLength: 254 };
const password: OpenAPIV3.SchemaObject = { type: 'string', minLength: 12, maxLength: 128, writeOnly: true };
const objectId: OpenAPIV3.SchemaObject = { type: 'string', pattern: '^[a-fA-F0-9]{24}$' };
const revision: OpenAPIV3.SchemaObject = { type: 'integer', minimum: 0 };
const grants: OpenAPIV3.SchemaObject = { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: false,
  required: ['permissionId', 'scope'], properties: { permissionId: objectId, scope: { type: 'string', enum: [...DATA_SCOPES] } } } };
const roleProperties: Record<string, OpenAPIV3.SchemaObject> = {
  name: { type: 'string', minLength: 2, maxLength: 100 }, code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{1,31}$' },
  description: { type: 'string', maxLength: 500 }, permissions: grants,
  allowsNoBranch: { type: 'boolean', default: false },
};
const policyProperties: Record<string, OpenAPIV3.SchemaObject> = {
  creatorRoleId: objectId, targetRoleId: objectId,
  allowedManagerRoleIds: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: objectId },
  branchRule: { type: 'string', enum: ['SAME_BRANCH', 'EXPLICIT_SCOPE'], default: 'SAME_BRANCH' },
  allowCrossBranchReporting: { type: 'boolean', default: false }, isActive: { type: 'boolean', default: true },
};
export const identitySchemas: Record<string, OpenAPIV3.SchemaObject> = {
  SuccessResponse: { type: 'object', required: ['success', 'message', 'data'], properties: {
    success: { type: 'boolean', enum: [true] }, message: { type: 'string' }, data: {}, meta: { type: 'object', properties: {
      page: { type: 'integer' }, limit: { type: 'integer' }, total: { type: 'integer' }, totalPages: { type: 'integer' },
    } },
  } },
  SessionResponse: { type: 'object', required: ['success', 'message', 'data'], properties: {
    success: { type: 'boolean', enum: [true] }, message: { type: 'string' }, data: { type: 'object', required: ['accessToken', 'csrfToken', 'expiresIn'], properties: {
      accessToken: { type: 'string' }, csrfToken: { type: 'string' }, expiresIn: { type: 'integer' },
    } },
  } },
  LoginRequest: { type: 'object', additionalProperties: false, required: ['email', 'password'], properties: { email, password: { ...password, minLength: 1 } } },
  ForgotPasswordRequest: { type: 'object', additionalProperties: false, required: ['email'], properties: { email } },
  ResetPasswordRequest: { type: 'object', additionalProperties: false, required: ['token', 'newPassword'], properties: {
    token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$', writeOnly: true }, newPassword: password,
  } },
  ChangePasswordRequest: { type: 'object', additionalProperties: false, required: ['currentPassword', 'newPassword'], properties: {
    currentPassword: { ...password, minLength: 1 }, newPassword: password,
  } },
  RoleCreateRequest: { type: 'object', additionalProperties: false, required: ['name', 'code'], properties: roleProperties },
  RoleUpdateRequest: { type: 'object', minProperties: 2, additionalProperties: false, required: ['revision'], properties: {
    revision, name: roleProperties.name ?? {}, description: roleProperties.description ?? {}, permissions: grants, isActive: { type: 'boolean' }, allowsNoBranch: { type: 'boolean' },
  } },
  RevisionRequest: { type: 'object', additionalProperties: false, required: ['revision'], properties: { revision } },
  PolicyCreateRequest: { type: 'object', additionalProperties: false, required: ['creatorRoleId', 'targetRoleId', 'allowedManagerRoleIds'], properties: policyProperties },
  PolicyUpdateRequest: { type: 'object', additionalProperties: false, required: ['creatorRoleId', 'targetRoleId', 'allowedManagerRoleIds', 'revision'], properties: { ...policyProperties, revision } },
};
