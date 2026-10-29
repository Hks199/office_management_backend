import type { OpenAPIV3 } from 'openapi-types';
const id: OpenAPIV3.SchemaObject = { type: 'string', pattern: '^[a-f0-9]{24}$' };
const time: OpenAPIV3.SchemaObject = { type: 'string', format: 'date-time' };
const revision: OpenAPIV3.SchemaObject = { type: 'integer', minimum: 0 };
const reason: OpenAPIV3.SchemaObject = { type: 'string', minLength: 3, maxLength: 500 };
const ref = (name: string): OpenAPIV3.ReferenceObject => ({ $ref: `#/components/schemas/${name}` });
const object = (properties: Record<string, OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject>, required: string[] = []): OpenAPIV3.SchemaObject => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const location = object({ latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 }, accuracyMeters: { type: 'number', minimum: 0, maximum: 100000 } }, ['latitude', 'longitude']);
export const attendanceSchemas: Record<string, OpenAPIV3.SchemaObject> = {
  AttendancePolicy: object({ startMinute: { type: 'integer', minimum: 0, maximum: 1439, nullable: true, default: null },
    endMinute: { type: 'integer', minimum: 1, maximum: 1439, nullable: true, default: null }, graceMinutes: { type: 'integer', minimum: 0, maximum: 120, default: 0 },
    maxAccuracyMeters: { type: 'number', minimum: 1, maximum: 10000, default: 100 }, maxCaptureAgeSeconds: { type: 'integer', minimum: 30, maximum: 900, default: 300 },
    geofence: { ...object({ latitude: { type: 'number', minimum: -90, maximum: 90 }, longitude: { type: 'number', minimum: -180, maximum: 180 }, radiusMeters: { type: 'number', minimum: 10, maximum: 100000 } }, ['latitude', 'longitude', 'radiusMeters']), nullable: true, default: null },
  }),
  AttendanceEvidence: object({ photoFileId: id, capturedAt: time, location }, ['photoFileId', 'capturedAt', 'location']),
  AttendanceSelfStatus: object({ action: { type: 'string', enum: ['check-in', 'check-out', null], nullable: true }, message: { type: 'string' } }, ['action', 'message']),
  AttendanceReview: object({ revision, reason, reviewStatus: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'] } }, ['revision', 'reason', 'reviewStatus']),
  AttendanceCorrection: object({ revision, reason, effectiveCheckInAt: time, effectiveCheckOutAt: { ...time, nullable: true } }, ['revision', 'reason', 'effectiveCheckInAt', 'effectiveCheckOutAt']),
  PhotoUpload: object({ purpose: { type: 'string', enum: ['ATTENDANCE_CHECK_IN', 'ATTENDANCE_CHECK_OUT'] }, filename: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}\\.(jpg|jpeg|png|webp)$' },
    contentType: { type: 'string', enum: ['image/jpeg', 'image/png', 'image/webp'] }, size: { type: 'integer', minimum: 12, maximum: 5242880 }, checksumSHA256: { type: 'string', pattern: '^[A-Za-z0-9+/]{43}=$' } }, ['purpose', 'filename', 'contentType', 'size', 'checksumSHA256']),
  Attendance: { type: 'object', properties: { _id: id, employeeId: id, branchId: { ...id, nullable: true }, attendanceDate: { type: 'string', format: 'date' },
    checkInAt: time, checkOutAt: { ...time, nullable: true }, effectiveCheckInAt: time, effectiveCheckOutAt: { ...time, nullable: true },
    checkInCapturedAt: time, checkOutCapturedAt: { ...time, nullable: true }, checkInPhotoFileId: id, checkOutPhotoFileId: { ...id, nullable: true },
    checkInLocation: location, checkOutLocation: { ...location, nullable: true }, policySnapshot: ref('AttendancePolicy'),
    evidenceFlags: { type: 'array', items: { type: 'string' } }, lateArrival: { type: 'boolean' }, earlyExit: { type: 'boolean' }, corrected: { type: 'boolean' }, revision,
    status: { type: 'string', enum: ['OPEN', 'COMPLETED'] }, reviewStatus: { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'] },
    reviewedBy: { ...id, nullable: true }, reviewedAt: { ...time, nullable: true }, remarks: { type: 'string' }, createdAt: time, updatedAt: time,
  } },
  PhotoUploadIntent: object({ fileId: id, expiresAt: time, upload: object({ method: { type: 'string', enum: ['POST'] }, url: { type: 'string', format: 'uri' }, fields: { type: 'object', additionalProperties: { type: 'string' } } }), instructions: { type: 'string' } }),
  PhotoFile: object({ _id: id, ownerId: id, purpose: { type: 'string' }, contentType: { type: 'string' }, size: { type: 'integer' },
    status: { type: 'string' }, expiresAt: time, confirmedAt: time, attendanceId: { ...id, nullable: true }, visitId: { ...id, nullable: true }, importId: { ...id, nullable: true }, exportId: { ...id, nullable: true }, createdAt: time, updatedAt: time }),
  PhotoDownload: object({ url: { type: 'string', format: 'uri' }, expiresInSeconds: { type: 'integer', enum: [60] } }),
  AttendanceSummary: object({ month: { type: 'string' }, timezone: { type: 'string', enum: ['Asia/Kolkata'] }, days: { type: 'array', items: object({
    _id: { type: 'string', format: 'date' }, records: { type: 'integer' }, completed: { type: 'integer' }, pendingReview: { type: 'integer' }, rejected: { type: 'integer' },
    lateArrivals: { type: 'integer' }, earlyExits: { type: 'integer' }, workedMinutes: { type: 'number' },
  }) } }),
};
const response = (name: string, list = false, status = '200'): OpenAPIV3.ResponsesObject => ({
  [status]: { description: 'Successful operation', content: { 'application/json': { schema: object({ success: { type: 'boolean' }, message: { type: 'string' },
    data: list ? { type: 'array', items: ref(name) } : ref(name), ...(list ? { meta: { type: 'object' as const } } : {}),
  }) } } },
  ...Object.fromEntries(['400', '401', '403', '404', '409', '429', '500', '503'].map((code) => [code, { description: 'Rejected; see error.code', content: { 'application/json': { schema: ref('ErrorResponse') } } }])),
});
const pathId: OpenAPIV3.ParameterObject = { in: 'path', name: 'id', required: true, schema: id };
const filter = (name: string, schema: OpenAPIV3.SchemaObject): OpenAPIV3.ParameterObject => ({ in: 'query', name, schema });
const filters = [filter('month', { type: 'string', pattern: '^20[0-9]{2}-(0[1-9]|1[0-2])$', description: 'Defaults to the current Kolkata month' }),
  filter('from', { type: 'string', format: 'date', description: 'Inclusive Kolkata business date; supply with to. Overrides month; maximum 366 dates.' }),
  filter('to', { type: 'string', format: 'date' }), filter('managerId', id), filter('roleId', id), filter('outsideGeofence', { type: 'boolean' }),
  filter('employeeId', id), filter('branchId', id), filter('status', { type: 'string', enum: ['OPEN', 'COMPLETED'] }), filter('reviewStatus', { type: 'string', enum: ['PENDING', 'APPROVED', 'REJECTED'] }),
  filter('lateArrival', { type: 'boolean' }), filter('earlyExit', { type: 'boolean' }), filter('page', { type: 'integer', minimum: 1, maximum: 10000, default: 1 }),
  filter('limit', { type: 'integer', minimum: 1, maximum: 100, default: 20 }), filter('sortOrder', { type: 'string', enum: ['asc', 'desc'], default: 'desc' })];
const operation = (operationId: string, name: string, summary: string, input?: string, parameters: OpenAPIV3.ParameterObject[] = [], list = false, status = '200'): OpenAPIV3.OperationObject => ({
  operationId, tags: [operationId.startsWith('photo') ? 'Files' : 'Attendance'], summary, security: [{ bearerAuth: [] }], parameters,
  ...(input ? { requestBody: { required: true, content: { 'application/json': { schema: ref(input) } } } } : {}), responses: response(name, list, status),
});
export const attendancePaths: OpenAPIV3.PathsObject = {
  '/files/upload-intents': { post: operation('photoUploadIntent', 'PhotoUploadIntent', 'Private exact-size POST upload; files:upload + attendance:create', 'PhotoUpload', [], false, '201') },
  '/files/{id}/confirm': { post: operation('photoConfirm', 'PhotoFile', 'Owner confirms checksum, signature and immutable S3 version', undefined, [pathId]) },
  '/files/{id}/download': { get: operation('photoDownload', 'PhotoDownload', 'files:read SELF/ALL intersected with attendance:read', undefined, [pathId]) },
  '/attendance/check-in': { post: operation('attendanceCheckIn', 'Attendance', 'Server-timed self check-in; one record per Kolkata business date', 'AttendanceEvidence', [], false, '201') },
  '/attendance/check-out': { post: operation('attendanceCheckOut', 'Attendance', 'Close own open record within 24 hours; evidence required', 'AttendanceEvidence') },
  '/attendance': { get: operation('attendanceList', 'Attendance', 'Scoped monthly history', undefined, filters, true) },
  '/attendance/me': { get: operation('attendanceMe', 'Attendance', 'Own monthly calendar records within granted scope', undefined, filters, true) },
  '/attendance/me/status': { get: operation('attendanceSelfStatus', 'AttendanceSelfStatus', 'Current self action including open attendance across month boundaries; attendance:create required') },
  '/attendance/summary': { get: operation('attendanceSummary', 'AttendanceSummary', 'Daily counts within one month; no absence/payroll assumptions', undefined, filters) },
  '/attendance/employee/{id}': { get: operation('attendanceEmployee', 'Attendance', 'Scoped employee calendar records; path employee overrides query', undefined, [pathId, ...filters], true) },
  '/attendance/branch/{id}': { get: operation('attendanceBranch', 'Attendance', 'Scoped branch history; path branch overrides query', undefined, [pathId, ...filters], true) },
  '/attendance/{id}/review': { patch: operation('attendanceReview', 'Attendance', 'Revision-checked scoped review; self review forbidden', 'AttendanceReview', [pathId]) },
  '/attendance/{id}/corrections': { post: operation('attendanceCorrection', 'Attendance', 'Audited scoped effective-time correction; original evidence preserved; self correction forbidden', 'AttendanceCorrection', [pathId]) },
};
for (const kind of ['check-in', 'check-out']) attendancePaths[`/attendance/{id}/photos/${kind}`] = {
  get: operation(`attendancePhoto_${kind.replace('-', '_')}`, 'PhotoDownload', 'Attendance evidence download authorized by parent attendance:read scope', undefined, [pathId]),
};
