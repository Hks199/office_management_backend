import type { OpenAPIV3 } from 'openapi-types';

const id: OpenAPIV3.SchemaObject = { type: 'string', pattern: '^[a-fA-F0-9]{24}$' };
const reportingManagers: OpenAPIV3.SchemaObject = { type: 'array', items: id, minItems: 1, maxItems: 10, uniqueItems: true, description: 'All selected managers receive role-scoped hierarchy access. The first manager is retained as reportingManagerId for compatibility.' };
const revision: OpenAPIV3.SchemaObject = { type: 'integer', minimum: 0 };
const reason: OpenAPIV3.SchemaObject = { type: 'string', minLength: 3, maxLength: 500 };
const ref = (name: string): OpenAPIV3.ReferenceObject => ({ $ref: `#/components/schemas/${name}` });
const content = (schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject) => ({ 'application/json': { schema } });
const response = (schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject, list = false, status = '200'): OpenAPIV3.ResponsesObject => ({
  [status]: { description: 'Successful operation', content: content({ type: 'object', required: ['success', 'message', 'data'], properties: {
    success: { type: 'boolean', enum: [true] }, message: { type: 'string' }, data: list ? { type: 'array', items: schema } : schema,
    ...(list ? { meta: { type: 'object' as const, required: ['page', 'limit', 'total', 'totalPages'], properties: {
      page: { type: 'integer' as const }, limit: { type: 'integer' as const }, total: { type: 'integer' as const }, totalPages: { type: 'integer' as const },
    } } } : {}),
  } }) },
  ...Object.fromEntries(['400', '401', '403', '404', '409', '429', '500', '503'].map((code) => [code, { description: 'Rejected; see error.code', content: content(ref('ErrorResponse')) }])),
});
const body = (name: string): OpenAPIV3.RequestBodyObject => ({ required: true, content: content(ref(name)) });
const pathId: OpenAPIV3.ParameterObject = { name: 'id', in: 'path', required: true, schema: id };
const parameter = (name: string, schema: OpenAPIV3.SchemaObject, required = false): OpenAPIV3.ParameterObject => ({ name, in: 'query', required, schema });
const pages = [parameter('page', { type: 'integer', minimum: 1, maximum: 10000, default: 1 }),
  parameter('limit', { type: 'integer', minimum: 1, maximum: 100, default: 20 }),
  parameter('sortOrder', { type: 'string', enum: ['asc', 'desc'], default: 'asc' }),
  parameter('isActive', { type: 'boolean' }), parameter('search', { type: 'string', minLength: 2, maxLength: 100 })];
const employeeFilters = [...pages, ...['branchId', 'roleId', 'managerId'].map((name) => parameter(name, id)),
  parameter('sortBy', { type: 'string', enum: ['employeeCode', 'firstName', 'createdAt', 'dateOfJoining'], default: 'employeeCode' }),
  parameter('employmentStatus', { type: 'string', enum: ['ACTIVE', 'ON_LEAVE', 'EXITED'] }),
  parameter('department', { type: 'string', maxLength: 100 }), parameter('startDate', { type: 'string', format: 'date-time' }), parameter('endDate', { type: 'string', format: 'date-time' })];
const security = [{ bearerAuth: [] }];
const employeeMutation = (operationId: string, schema: string, summary: string): OpenAPIV3.OperationObject => ({
  tags: ['Employees'], operationId, summary, security, parameters: [pathId], requestBody: body(schema), responses: response(ref('Employee')),
});
export const organizationPaths: OpenAPIV3.PathsObject = {
  '/employees/manager-options': { get: { tags: ['Employees'], operationId: 'employeeCreationManagerOptions', security,
    summary: 'Minimal reporting-manager labels for an approved creation template; BDOs creating MH may select their root MD',
    parameters: [...pages.filter((entry) => entry.name !== 'isActive'), parameter('roleId', id, true)], responses: response(ref('EmployeeManagerOption'), true) } },
  '/employees/branch-options': { get: { tags: ['Employees'], operationId: 'employeeCreationBranchOptions', security,
    summary: 'Minimal active branch labels for an approved users:create template; company-wide BDO and MH managers may establish a team across branches',
    parameters: [...pages.filter((entry) => entry.name !== 'isActive'), parameter('roleId', id, true)], responses: response(ref('EmployeeBranchOption'), true) } },
  '/employees/role-options': { get: { tags: ['Employees'], operationId: 'employeeCreationRoleOptions', security,
    summary: 'Minimal approved role options for users:create; no role-administration permission required',
    parameters: pages.filter((entry) => entry.name !== 'isActive'), responses: response(ref('EmployeeRoleOption'), true) } },
  '/employees/role-options/assignment': { get: { tags: ['Employees'], operationId: 'employeeAssignmentRoleOptions', security,
    summary: 'Minimal approved role options for roles:assign ALL',
    parameters: pages.filter((entry) => entry.name !== 'isActive'), responses: response(ref('EmployeeRoleOption'), true) } },
  '/employees': {
    get: { tags: ['Employees'], operationId: 'listEmployees', security, parameters: employeeFilters, summary: 'Scope-filtered employee list; users:read required', responses: response(ref('Employee'), true) },
    post: { tags: ['Employees'], operationId: 'createEmployee', security, summary: 'Create approved subordinate and queue an invitation', requestBody: body('EmployeeCreateRequest'), responses: response(ref('Employee'), false, '201') },
  },
  '/employees/{id}': {
    get: { tags: ['Employees'], operationId: 'getEmployee', security, parameters: [pathId], responses: response(ref('Employee')) },
    patch: employeeMutation('updateEmployee', 'EmployeeUpdateRequest', 'Update authorized profile with expected revision'),
  },
  '/employees/hierarchy': { get: { tags: ['Employees'], operationId: 'getHierarchy', security, summary: 'Paginated flat hierarchy, root included only when visible',
    parameters: [...employeeFilters, parameter('rootId', id), parameter('depth', { type: 'integer', minimum: 1, maximum: 20, default: 20 })], responses: response(ref('Employee'), true) } },
  '/employees/downlines': { get: { tags: ['Employees'], operationId: 'getDownlines', security, summary: 'Paginated descendants; root excluded',
    parameters: [...employeeFilters, parameter('rootId', id), parameter('depth', { type: 'integer', minimum: 1, maximum: 20, default: 20 })], responses: response(ref('Employee'), true) } },
  '/employees/{id}/manager': { patch: employeeMutation('changeManager', 'EmployeeManagerRequest', 'Cycle-safe manager change; affected employee sessions revoked') },
  '/employees/{id}/branch': { patch: employeeMutation('transferEmployee', 'EmployeeTransferRequest', 'Authorize old/new placement, preserve history and revoke affected sessions') },
  '/employees/{id}/role': { patch: employeeMutation('assignEmployeeRole', 'EmployeeRoleRequest', 'roles:assign ALL and approved target template required') },
  '/employees/{id}/status': { patch: employeeMutation('setEmployeeStatus', 'EmployeeStatusRequest', 'Soft deactivation/reactivation with last-admin and report guards') },
  '/branches': {
    get: { tags: ['Branches'], operationId: 'listBranches', security, parameters: [...pages,
      ...['stateId', 'districtId', 'blockId'].map((name) => parameter(name, id)),
      parameter('sortBy', { type: 'string', enum: ['branchName', 'branchCode', 'createdAt'], default: 'branchName' })], responses: response(ref('Branch'), true) },
    post: { tags: ['Branches'], operationId: 'createBranch', security, requestBody: body('BranchCreateRequest'), responses: response(ref('Branch'), false, '201') },
  },
  '/branches/{id}': {
    get: { tags: ['Branches'], operationId: 'getBranch', security, parameters: [pathId], responses: response(ref('Branch')) },
    patch: { tags: ['Branches'], operationId: 'updateBranch', security, parameters: [pathId], requestBody: body('BranchUpdateRequest'), summary: 'BH profile-only edits; locations/status need branches:update ALL', responses: response(ref('Branch')) },
  },
  '/branches/{id}/head': { patch: { tags: ['Branches'], operationId: 'assignBranchHead', security, parameters: [pathId], requestBody: body('BranchHeadRequest'), responses: response(ref('Branch')) } },
};
for (const kind of ['states', 'districts', 'blocks'] as const) {
  const parent = kind === 'districts' ? 'stateId' : 'districtId';
  organizationPaths[`/locations/${kind}`] = {
    get: { tags: ['Locations'], operationId: `list_${kind}`, security, parameters: [...pages, ...(kind === 'states' ? [] : [parameter(parent, id, true)])], responses: response(ref('Location'), true) },
    post: { tags: ['Locations'], operationId: `create_${kind}`, security, requestBody: body(`Create_${kind}`), responses: response(ref('Location'), false, '201') },
  };
  organizationPaths[`/locations/${kind}/{id}`] = { patch: { tags: ['Locations'], operationId: `update_${kind}`, security,
    parameters: [pathId], requestBody: body('LocationUpdateRequest'), summary: 'Admin name/status update; parent and code immutable', responses: response(ref('Location')) } };
}
const profile: Record<string, OpenAPIV3.SchemaObject> = { firstName: { type: 'string', minLength: 1, maxLength: 80 }, lastName: { type: 'string', minLength: 1, maxLength: 80 },
  email: { type: 'string', format: 'email', maxLength: 254 }, mobileNumber: { type: 'string', maxLength: 30, description: 'Accepts a 10-digit Indian number or an international number with country code. Indian local numbers are normalized to +91 before storage.' },
  dateOfJoining: { type: 'string', format: 'date-time' }, designation: { type: 'string', maxLength: 100 }, department: { type: 'string', maxLength: 100 } };
const createEmployee: Record<string, OpenAPIV3.SchemaObject> = { ...profile, employeeCode: { type: 'string', pattern: '^[A-Z0-9-]{2,32}$' },
  roleId: id, branchId: { ...id, nullable: true }, reportingManagerId: id, reportingManagerIds: reportingManagers };
const mutation = (properties: Record<string, OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject>, required: string[]): OpenAPIV3.SchemaObject => ({
  type: 'object', additionalProperties: false, required, properties,
});
const branchProfile: Record<string, OpenAPIV3.SchemaObject> = { branchName: { type: 'string', minLength: 2, maxLength: 100 }, address: { type: 'string', minLength: 5, maxLength: 500 }, contactNumber: profile.mobileNumber ?? {} };
const branchLocation = { stateId: id, districtId: id, blockId: { ...id, nullable: true } };
export const organizationSchemas: Record<string, OpenAPIV3.SchemaObject> = {
  EmployeeManagerOption: mutation({ _id: id, label: { type: 'string' } }, ['_id', 'label']),
  EmployeeBranchOption: mutation({ _id: id, branchName: { type: 'string' }, branchCode: { type: 'string' } }, ['_id', 'branchName', 'branchCode']),
  EmployeeRoleOption: mutation({ _id: id, name: { type: 'string' }, code: { type: 'string' }, allowsNoBranch: { type: 'boolean' } }, ['_id', 'name', 'code', 'allowsNoBranch']),
  Employee: { type: 'object', properties: { ...createEmployee, _id: id, reportingManagerId: { ...id, nullable: true }, reportingManagerIds: { ...reportingManagers, minItems: 0 },
    roleName: { type: 'string', nullable: true }, roleCode: { type: 'string', nullable: true },
    branchName: { type: 'string', nullable: true }, branchCode: { type: 'string', nullable: true },
    reportingManagerName: { type: 'string', nullable: true }, reportingManagerCode: { type: 'string', nullable: true }, reportingManagerNames: { type: 'array', items: { type: 'string' } }, reportingManagerCodes: { type: 'array', items: { type: 'string' } },
    isActive: { type: 'boolean' }, employmentStatus: { type: 'string', enum: ['ACTIVE', 'ON_LEAVE', 'EXITED'] }, revision,
    createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' },
    invitationStatus: { type: 'string', enum: ['PENDING'] }, hierarchyDepth: { type: 'integer', minimum: 0, maximum: 20 } } },
  EmployeeCreateRequest: { ...mutation(createEmployee, ['employeeCode', 'firstName', 'lastName', 'email', 'mobileNumber', 'roleId', 'branchId', 'dateOfJoining']), anyOf: [{ required: ['reportingManagerId'] }, { required: ['reportingManagerIds'] }] },
  EmployeeUpdateRequest: { ...mutation({ revision, ...profile }, ['revision']), minProperties: 2 },
  EmployeeManagerRequest: { ...mutation({ revision, reason, reportingManagerId: id, reportingManagerIds: reportingManagers }, ['revision', 'reason']), anyOf: [{ required: ['reportingManagerId'] }, { required: ['reportingManagerIds'] }] },
  EmployeeTransferRequest: { ...mutation({ revision, reason, reportingManagerId: id, reportingManagerIds: reportingManagers, branchId: { ...id, nullable: true } }, ['revision', 'reason', 'branchId']), anyOf: [{ required: ['reportingManagerId'] }, { required: ['reportingManagerIds'] }] },
  EmployeeRoleRequest: mutation({ revision, reason, roleId: id }, ['revision', 'reason', 'roleId']),
  EmployeeStatusRequest: mutation({ revision, reason, isActive: { type: 'boolean' }, employmentStatus: { type: 'string', enum: ['ACTIVE', 'ON_LEAVE', 'EXITED'] } }, ['revision', 'reason', 'isActive', 'employmentStatus']),
  Branch: { type: 'object', properties: { _id: id, ...branchProfile, ...branchLocation, branchCode: { type: 'string' }, branchHeadId: { ...id, nullable: true },
    isActive: { type: 'boolean' }, attendancePolicy: ref('AttendancePolicy'), revision, createdBy: id, createdAt: { type: 'string', format: 'date-time' }, updatedAt: { type: 'string', format: 'date-time' } } },
  BranchCreateRequest: mutation({ branchCode: { type: 'string', pattern: '^[A-Z0-9_-]{2,32}$' }, ...branchProfile, ...branchLocation, attendancePolicy: ref('AttendancePolicy') }, ['branchCode', 'branchName', 'address', 'contactNumber', 'stateId', 'districtId']),
  BranchUpdateRequest: { ...mutation({ revision, ...branchProfile, ...branchLocation, isActive: { type: 'boolean' }, attendancePolicy: ref('AttendancePolicy') }, ['revision']), minProperties: 2 },
  BranchHeadRequest: mutation({ revision, reason, branchHeadId: { ...id, nullable: true } }, ['revision', 'reason', 'branchHeadId']),
  Location: { type: 'object', properties: { _id: id, code: { type: 'string' }, name: { type: 'string' }, stateId: id, districtId: id,
    kind: { type: 'string', enum: ['BLOCK', 'TEHSIL'] }, sourceVersion: { type: 'string' }, isActive: { type: 'boolean' }, revision, createdBy: id } },
  LocationUpdateRequest: { ...mutation({ revision, name: { type: 'string', minLength: 1, maxLength: 100 }, isActive: { type: 'boolean' } }, ['revision']), minProperties: 2 },
};
for (const kind of ['states', 'districts', 'blocks'] as const) {
  const parent = kind === 'districts' ? 'stateId' : 'districtId';
  organizationSchemas[`Create_${kind}`] = mutation({ code: { type: 'string', pattern: '^[A-Z0-9_-]{1,32}$' }, name: { type: 'string', minLength: 1, maxLength: 100 },
    sourceVersion: { type: 'string', maxLength: 100 }, ...(kind === 'states' ? {} : { [parent]: id }),
    ...(kind === 'blocks' ? { kind: { type: 'string', enum: ['BLOCK', 'TEHSIL'] } } : {}),
  }, ['code', 'name', ...(kind === 'states' ? [] : [parent]), ...(kind === 'blocks' ? ['kind'] : [])]);
}
