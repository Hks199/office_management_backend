# CODEX MASTER PROMPT
## Sunvika Office Management Software — Production Backend

### 1. Your Role

Act as a **Senior Backend Architect, Node.js Engineer, TypeScript Expert, MongoDB Database Architect, and Application Security Engineer**.

Your task is to design and develop a complete, scalable, secure, maintainable, production-ready REST API backend for **Sunvika Pvt. Ltd.**, a company providing solar panel installation and Annual Maintenance Contract (AMC) services.

This is a real-world enterprise office management application.

**Technology stack:**

- Runtime: Node.js (current supported LTS)
- Framework: Express.js
- Language: TypeScript (strict mode)
- Database: MongoDB
- ODM: Mongoose
- Validation: Joi
- File storage: AWS S3 (private bucket)
- Authentication: JWT access tokens and secure refresh-token rotation
- Password hashing: Argon2id
- API documentation: Swagger / OpenAPI 3
- Logging: Pino
- Testing: Jest or Vitest + Supertest
- Security: Helmet, CORS, rate limiting, input validation, authorization, audit logging
- CSV processing: streaming parser with safe validation
- Date handling: UTC storage, Asia/Kolkata business timezone
- Deployment: Docker-ready

Do not use JavaScript for backend source files. Use TypeScript with strong typing.

### 2. Project Objective

Build a centralized office management backend with the following modules:

1. Employee management
2. Dynamic roles and permissions
3. Employee hierarchy management
4. Branch management
5. Attendance management with GPS and photographic evidence
6. Telecaller daily reporting
7. Sales executive site visit reporting
8. Lead management and assignment
9. CSV customer data imports
10. Target management
11. Advanced role-based dashboards
12. Advanced filtering and reporting
13. Activity logs and audit trails
14. State, district and block/tehsil master data
15. Secure file management using AWS S3
16. Notifications and reminders
17. Solar installation and AMC tracking foundations

The system must support future expansion without major architectural changes.

---

## 3. Employee Roles and Hierarchy

Default organizational hierarchy:

```text
                    MD
           Managing Director
                    |
                   BDO
       Business Development Officer
                    |
                   MH
              Marketing Head
                    |
                   BH
               Branch Head
                    |
             +------+------+
             |             |
            SEx            TC
      Sales Executive   Telecaller
```

This is the default hierarchy, not a permanently hardcoded structure.

The application must support dynamic organizational relationships.

### Default role responsibilities

**MD — Managing Director**

- Has all business-management permissions.
- Can create employees and assign roles.
- Can create, update, and deactivate custom roles.
- Can assign permissions to roles.
- Can manage all branches.
- Can view and manage all employees.
- Can view all attendance records.
- Can access all leads and reports.
- Can assign leads to eligible employees.
- Can configure targets.
- Can view company-wide analytics.
- Can review activity logs.
- Can manage organizational hierarchy.
- Can control master data and business settings.

MD business access must not bypass system-level security, validation, or audit requirements.

**BDO — Business Development Officer**

- Can create employees in permitted subordinate roles.
- Can view and manage employees in their authorized reporting subtree.
- Can view reports, attendance, targets, and leads belonging to their downlines.
- Can assign targets to authorized subordinates.
- Can review subordinate performance.
- Cannot access unrelated organizational subtrees.

**MH — Marketing Head**

- Can create employees in permitted subordinate roles.
- Can manage their authorized downline employees.
- Can upload customer CSV files if granted permission.
- Can assign telecalling work.
- Can configure targets for their authorized employees.
- Can review telecaller and sales performance.
- Can view and manage leads within their scope.
- Cannot access unrelated employees or branches without explicit permission.

**BH — Branch Head**

- Can manage employees belonging to their assigned branch.
- Can create permitted subordinate employees in their branch.
- Can view attendance, reports, leads, and performance within that branch.
- Can manage branch-specific targets and assignments.
- Cannot access other branches without explicitly granted scope.
- Branch-wide access and reporting-subtree access must be independently enforceable.

**SEx — Sales Executive**

- Can view their own profile, attendance, targets, assigned leads, and reports.
- Can submit site visit reports.
- Can upload site visit photographs.
- Can submit site visit GPS coordinates.
- Can update authorized lead stages.
- Can view personal dashboard statistics.
- Cannot view another sales executive's private records.

**TC — Telecaller**

- Can view customers assigned to them.
- Can submit daily calling reports.
- Can update calling outcomes.
- Can convert eligible customer records into leads.
- Can assign or propose lead assignment to an eligible SEx according to permission rules.
- Can view personal calling targets and performance.
- Cannot view unrelated customer data.

### Important hierarchy rules

- No public employee registration.
- Employees are created only by authorized existing employees.
- The initial MD account must be provisioned through a secure internal bootstrap command.
- BDO, MH, and BH can create only roles allowed by the role-creation policy.
- New employees must have a valid reporting manager.
- Prevent circular reporting relationships.
- Prevent employees from becoming their own manager.
- Prevent unauthorized cross-branch reporting relationships.
- Support employee transfer, manager change, and branch transfer with audit trails.
- Revalidate authorization after hierarchy changes.

Do not assume that role names alone determine access.

Implement both:

1. **RBAC:** What actions an employee may perform.
2. **Data scope authorization:** Which records the employee may access.

Supported scopes should include:

```text
SELF
DIRECT_REPORTS
REPORTING_SUBTREE
BRANCH
ASSIGNED
ALL
```

Permission examples:

```text
users:create
users:read
users:update
users:deactivate

roles:create
roles:read
roles:update
roles:delete
roles:assign

permissions:read
permissions:assign

attendance:create
attendance:read
attendance:review

leads:create
leads:read
leads:update
leads:assign
leads:import
leads:export

reports:create
reports:read
reports:review

targets:create
targets:read
targets:update

dashboard:read
dashboard:export

activity_logs:read

branches:create
branches:read
branches:update
```

A permission can have an authorized scope.

For example:

```json
{
  "permission": "attendance:read",
  "scope": "REPORTING_SUBTREE"
}
```

Never rely on frontend-hidden buttons for authorization.

Every protected API must enforce permissions and record-level access on the backend.

---

## 4. Dynamic Role and Permission Management

MD must be able to manage custom roles from the admin panel.

Examples of future roles:

- Area Manager
- Regional Manager
- Field Supervisor
- Installation Engineer
- AMC Technician
- Operations Manager

Create these MongoDB collections:

```text
roles
permissions
role_creation_policies
```

Role model:

```ts
interface IRole {
  name: string;
  code: string;
  description?: string;
  permissions: Array<{
    permissionId: ObjectId;
    scope: DataScope;
  }>;
  isSystemRole: boolean;
  isActive: boolean;
  createdBy: ObjectId;
  createdAt: Date;
  updatedAt: Date;
}
```

Important requirements:

- MD can create new roles.
- MD can assign existing permissions.
- MD can define allowed subordinate roles.
- System roles must be protected from accidental deletion.
- Permission definitions must come from a controlled backend registry.
- MD must not be allowed to create arbitrary executable permissions.
- Custom roles should support configurable reporting relationships.
- Permission changes must be logged.
- Changes to roles should invalidate or refresh cached authorization state.
- Prevent privilege escalation through employee creation or role assignment.
- Only authorized users may assign sensitive permissions.

Implement middleware such as:

```ts
authenticate()
authorize("leads:read")
authorizeScope("leads:read", resource)
```

For collection endpoints, scope restrictions must be applied directly to MongoDB queries.

For individual resources, verify access before returning, modifying, or deleting records.

---

## 5. Project Folder Structure

Use a modular, feature-based architecture with separate models, controllers, services, repositories, routes, validators, middleware, and utilities.

Recommended structure:

```text
sunvika-backend/
├── src/
│   ├── app.ts
│   ├── server.ts
│   ├── config/
│   │   ├── env.ts
│   │   ├── database.ts
│   │   ├── aws.ts
│   │   ├── cors.ts
│   │   └── swagger.ts
│   ├── constants/
│   │   ├── roles.ts
│   │   ├── permissions.ts
│   │   ├── attendance.ts
│   │   ├── lead-status.ts
│   │   └── report-status.ts
│   ├── modules/
│   │   ├── auth/
│   │   ├── users/
│   │   ├── roles/
│   │   ├── permissions/
│   │   ├── hierarchy/
│   │   ├── branches/
│   │   ├── attendance/
│   │   ├── customers/
│   │   ├── leads/
│   │   ├── lead-assignments/
│   │   ├── telecaller-reports/
│   │   ├── sales-reports/
│   │   ├── targets/
│   │   ├── dashboards/
│   │   ├── csv-imports/
│   │   ├── files/
│   │   ├── locations/
│   │   ├── activity-logs/
│   │   ├── notifications/
│   │   └── solar-projects/
│   ├── middleware/
│   │   ├── authenticate.ts
│   │   ├── authorize.ts
│   │   ├── authorize-scope.ts
│   │   ├── validate.ts
│   │   ├── rate-limiter.ts
│   │   ├── request-id.ts
│   │   ├── error-handler.ts
│   │   └── not-found.ts
│   ├── shared/
│   │   ├── errors/
│   │   ├── types/
│   │   ├── interfaces/
│   │   ├── repositories/
│   │   ├── services/
│   │   └── utils/
│   ├── jobs/
│   ├── scripts/
│   │   ├── bootstrap-md.ts
│   │   ├── seed-permissions.ts
│   │   ├── seed-roles.ts
│   │   └── seed-locations.ts
│   └── docs/
├── tests/
│   ├── unit/
│   ├── integration/
│   └── security/
├── docker/
├── .env.example
├── .gitignore
├── Dockerfile
├── docker-compose.yml
├── tsconfig.json
├── package.json
├── README.md
└── API_DOCUMENTATION.md
```

Each feature module should follow:

```text
users/
├── user.model.ts
├── user.interface.ts
├── user.validator.ts
├── user.controller.ts
├── user.service.ts
├── user.repository.ts
├── user.routes.ts
└── user.types.ts
```

Keep controllers thin.

Controllers should handle HTTP requests and responses.

Services should contain business logic.

Repositories should handle database access.

Validators should validate incoming data.

Do not place all business logic inside controllers.

---

## 6. Database Design

Use Mongoose with strongly typed schemas.

Implement these collections:

| Collection | Purpose |
|---|---|
| users | Employee profiles and authentication |
| roles | System and custom roles |
| permissions | Available permissions |
| role_creation_policies | Authorized role creation relationships |
| branches | Branch information |
| attendance | Employee attendance and GPS |
| customers | Imported and assigned calling contacts |
| leads | Qualified sales opportunities |
| lead_assignments | Lead assignment history |
| telecaller_reports | Calling reports |
| sales_visit_reports | Sales visit records |
| targets | Employee targets |
| activity_logs | User activity and security audit |
| states | State master data |
| districts | District master data |
| blocks | Block/tehsil master data |
| csv_imports | CSV import history and status |
| files | S3 file metadata |
| refresh_sessions | Refresh-token session records |
| notifications | Employee notifications |
| solar_projects | Future installation/AMC lifecycle |

### User model

Fields:

```text
_id
employeeCode
firstName
lastName
email
mobileNumber
passwordHash
roleId
branchId
reportingManagerId
designation
department
dateOfJoining
employmentStatus
isActive
createdBy
lastLoginAt
passwordChangedAt
createdAt
updatedAt
```

Use a unique employee code.

Use normalized unique email/mobile fields according to company policy.

Never expose password hashes in API responses.

Use indexed reportingManagerId and branchId.

### Branch model

```text
_id
branchCode
branchName
address
stateId
districtId
blockId
contactNumber
branchHeadId
isActive
createdBy
createdAt
updatedAt
```

A branch head should be an authorized employee.

Define validation for branch head reassignment.

### Lead model

Implement the complete Sunvika lead structure.

```text
_id
leadCode

customerName
mobileNumber
alternateNumber

branchId
stateId
districtId
blockId
tehsil

siteAddress

requiredCapacityKw
ratePerKw
estimatedProjectValue

paymentMode
panelBrand
panelTechnology

status
leadSource

createdBy
assignedTo
assignedBy
assignedAt

telecallerId
salesExecutiveId

nextFollowUpAt
lastContactedAt
remarks

createdAt
updatedAt
```

Use `assignedTo` as the canonical current assignee field.

Use `assignedBy` to identify the employee who performed the assignment.

Store assignment history in `lead_assignments`.

Do not introduce two ambiguous current-assignee fields.

Calculate:

```ts
estimatedProjectValue =
  requiredCapacityKw * ratePerKw;
```

Validate nonnegative numeric values and appropriate units.

Do not trust a client-submitted calculated value.

Suggested lead statuses:

```text
NEW
ASSIGNED
CONTACTED
INTERESTED
QUALIFIED
SITE_VISIT_SCHEDULED
SITE_VISITED
QUOTATION_SENT
NEGOTIATION
CONVERTED
NOT_INTERESTED
LOST
ON_HOLD
```

Implement validated lead status transitions.

Do not allow arbitrary status changes.

Keep status history and assignment history.

Make payment modes, panel brands, and panel technologies configurable reference values where practical.

---

## 7. Employee Registration and Management

Implement employee creation through authorized users only.

API examples:

```http
POST /api/v1/employees
GET /api/v1/employees
GET /api/v1/employees/:id
PATCH /api/v1/employees/:id
PATCH /api/v1/employees/:id/status
PATCH /api/v1/employees/:id/manager
PATCH /api/v1/employees/:id/branch
GET /api/v1/employees/hierarchy
GET /api/v1/employees/downlines
```

Employee creation must validate:

- Creator's permission.
- Target role eligibility.
- Reporting manager eligibility.
- Branch assignment scope.
- Unique employee identifiers.
- Active role and manager.
- No privilege escalation.

Use a secure initial password setup or invitation process.

Do not email plaintext passwords.

Do not expose an open registration endpoint.

Implement employee soft deactivation rather than deleting important historical records.

---

## 8. Attendance Management

Every employee must mark attendance by submitting:

1. Employee-authenticated request
2. Current photograph
3. GPS latitude
4. GPS longitude
5. Client-captured timestamp
6. Optional GPS accuracy

Attendance model:

```text
_id
employeeId
branchId
attendanceDate

checkInAt
checkOutAt

checkInPhotoFileId
checkOutPhotoFileId

checkInLocation:
  latitude
  longitude
  accuracyMeters

checkOutLocation:
  latitude
  longitude
  accuracyMeters

status
reviewStatus
reviewedBy
reviewedAt
remarks

createdAt
updatedAt
```

Requirements:

- Server determines authenticated employee.
- Server timestamps are authoritative.
- Attendance business date uses Asia/Kolkata timezone.
- Prevent duplicate check-in records for the same business date.
- Support check-in and check-out.
- Capture photographs through the frontend.
- Store photographs in private AWS S3.
- Store S3 object references in MongoDB.
- Validate latitude from -90 to 90.
- Validate longitude from -180 to 180.
- Validate location accuracy.
- Support optional office geofencing configured by branch.
- Track late arrivals, early exits, and attendance corrections.
- Implement review workflows for manual adjustments.
- Maintain immutable correction audit events.
- Support attendance calendar and monthly summaries.

Important security note:

Browser-provided GPS and camera images are evidence, not cryptographic proof of physical presence.

Do not claim that coordinates or photographs alone prevent spoofing.

Implement configurable verification policies and flag suspicious submissions for review.

Attendance API examples:

```http
POST /api/v1/attendance/check-in
POST /api/v1/attendance/check-out

GET /api/v1/attendance/me
GET /api/v1/attendance
GET /api/v1/attendance/summary

GET /api/v1/attendance/employee/:id
GET /api/v1/attendance/branch/:id

PATCH /api/v1/attendance/:id/review
```

Authorization must apply to every attendance record and aggregation.

---

## 9. Telecaller Management

Telecallers receive customer calling lists uploaded by MD or authorized MH employees.

### CSV import

Support uploading CSV files containing:

```text
Customer Name
Mobile Number
Alternate Number
State
District
Block/Tehsil
Site Address
Remarks
```

CSV import workflow:

1. Authorized user uploads CSV.
2. Backend validates file size and format.
3. Parse CSV safely using a streaming parser.
4. Validate each row with Joi.
5. Normalize phone numbers.
6. Identify duplicates according to configurable rules.
7. Return an import preview or validation report.
8. Confirm import.
9. Save accepted customer records.
10. Record rejected rows with reasons.
11. Assign customers to authorized telecallers.
12. Save import history and audit information.

Large imports must use background processing.

Avoid loading an entire large CSV into memory.

Prevent spreadsheet formula injection when exporting CSV files.

### Customer assignment

MD or authorized MH can assign imported customers to telecallers.

Support bulk assignment and reassignment.

Telecaller must only see assigned customers.

### Telecaller calling report

Create `telecaller_reports` and individual call activity records where appropriate.

Fields:

```text
employeeId
customerId
leadId
callStartedAt
callEndedAt
callDurationSeconds
callOutcome
customerInterest
followUpAt
remarks
convertedToLead
createdAt
updatedAt
```

Suggested outcomes:

```text
CONNECTED
NOT_ANSWERED
BUSY
SWITCHED_OFF
WRONG_NUMBER
CALLBACK_REQUESTED
INTERESTED
NOT_INTERESTED
```

Each call activity must be linked to an authorized customer.

Do not trust client-provided call durations without validation.

### Lead conversion

Telecaller should be able to:

- Mark customer as interested.
- Convert an eligible customer into a lead.
- Add customer requirements.
- Recommend or assign a sales executive when authorized.
- Schedule follow-up.
- View conversion history.

Prevent duplicate lead conversion caused by repeated requests.

### Telecaller daily dashboard

Show:

- Total assigned customers
- Calls made today
- Connected calls
- Unanswered calls
- Interested customers
- Leads generated
- Conversion rate
- Pending follow-ups
- Daily target
- Target achievement percentage

---

## 10. Sales Executive Site Visit Reports

Sales executives visit potential solar customers.

Each visit requires a report.

Fields:

```text
_id
leadId
salesExecutiveId
branchId

visitDate
visitStartedAt
visitCompletedAt

customerName
customerMobile

siteAddress
location:
  latitude
  longitude
  accuracyMeters

photoFileIds[]

requiredCapacityKw
customerInterest
installationReadiness
estimatedProjectValue

discussionNotes
nextFollowUpAt
visitOutcome

createdAt
updatedAt
```

Visit workflow:

1. SEx selects an assigned lead.
2. Starts a site visit.
3. Captures current GPS coordinates.
4. Captures site photographs.
5. Submits visit details.
6. Backend validates lead access.
7. Backend stores photographs in private S3.
8. Backend stores location coordinates.
9. Backend updates lead status when appropriate.
10. Backend records the activity.

A lead may have multiple site visits.

Never overwrite previous site visits.

### Map integration

Frontend must be able to display visit locations using latitude and longitude.

Backend should return:

```json
{
  "location": {
    "latitude": 21.2514,
    "longitude": 81.6296
  }
}
```

Also support geospatial queries using GeoJSON with a MongoDB `2dsphere` index when location search is required.

Use a consistent coordinate conversion because GeoJSON stores longitude before latitude.

### Sales Executive dashboard

Show:

- Assigned leads
- Visits completed today
- Visits completed this month
- Interested customers
- Converted leads
- Pending follow-ups
- Monthly target
- Target achieved
- Conversion percentage
- Recent visits

---

## 11. Target Management

Create a flexible target management module.

Targets can be created by authorized managers for employees within their scope.

Supported target types:

```text
CALLS_COMPLETED
CONNECTED_CALLS
LEADS_GENERATED
SITE_VISITS
QUALIFIED_LEADS
CONVERSIONS
SALES_VALUE
```

Target model:

```text
_id
employeeId
targetType
targetValue
periodType
startDate
endDate
assignedBy
branchId
status
createdAt
updatedAt
```

Supported periods:

```text
DAILY
WEEKLY
MONTHLY
CUSTOM
```

Requirements:

- MD can manage company-wide targets.
- Authorized managers can manage subordinate targets.
- BH can manage branch-specific targets.
- TC can see their calling targets.
- SEx can see their visit and conversion targets.
- Target progress must be calculated from verified underlying activity.
- Avoid counting duplicate activities.
- Support historical target revisions and audit trails.

Target achievement:

```ts
achievementPercentage =
  targetValue > 0
    ? (actualValue / targetValue) * 100
    : 0;
```

Do not cap the stored achievement percentage at 100%, because employees may exceed their targets.

---

## 12. Advanced Dashboards

Create role-specific dashboard APIs with data-scoped MongoDB aggregations.

### MD dashboard

Include:

- Total employees
- Active employees
- Branch count
- Attendance today
- Absent employees
- Total customers
- Total leads
- Leads converted
- Pending leads
- Total site visits
- Calling performance
- Sales performance
- Branch-wise performance
- Role-wise performance
- Target achievement
- Monthly trends
- Lead funnel
- Top-performing employees
- Recent activities

### BDO dashboard

Show only authorized reporting-subtree data.

Include:

- Downline employee count
- Downline attendance
- Lead performance
- Target progress
- Employee performance
- Branch distribution within scope
- Pending reports

### MH dashboard

Include:

- Telecaller productivity
- Customer import statistics
- Leads generated
- Conversion rate
- Team target achievement
- Follow-up performance
- Sales visits from authorized team
- Employee-wise performance

### BH dashboard

Include:

- Branch employee count
- Branch attendance
- Branch leads
- Branch site visits
- Branch conversion statistics
- Employee targets
- Branch monthly performance

### SEx dashboard

Include only own authorized data.

### TC dashboard

Include only own authorized data.

### Dashboard API examples

```http
GET /api/v1/dashboard/overview
GET /api/v1/dashboard/attendance
GET /api/v1/dashboard/leads
GET /api/v1/dashboard/targets
GET /api/v1/dashboard/employee-performance
GET /api/v1/dashboard/branch-performance
GET /api/v1/dashboard/lead-funnel
GET /api/v1/dashboard/trends
```

Prefer shared, permission-aware dashboard endpoints over duplicating the same business logic for each role.

---

## 13. Advanced Filters and Pagination

All list and reporting APIs must support appropriate filters.

Examples:

```text
startDate
endDate
branchId
employeeId
managerId
roleId
stateId
districtId
blockId
status
assignedTo
createdBy
leadSource
targetType
search
sortBy
sortOrder
page
limit
```

Example:

```http
GET /api/v1/leads?branchId=123&status=INTERESTED&page=1&limit=20
```

Use Joi validation for query parameters.

Implement:

- Pagination
- Sorting
- Search
- Date range filtering
- Multi-status filtering
- Role filtering
- Branch filtering
- Employee filtering
- Export support
- Aggregate summaries

All filters must be combined with authorization restrictions.

Never allow a client-supplied branch ID or employee ID to override access scope.

Apply data access restrictions before aggregation and pagination.

Implement indexes based on actual query patterns.

Prevent unsafe sorting, unbounded queries, and expensive unrestricted regex searches.

---

## 14. AWS S3 File Storage

Use AWS SDK v3.

Store:

```text
attendance photos
site visit photos
customer import files
employee documents
report attachments
```

Recommended object structure:

```text
sunvika/
  attendance/
    employee-id/
      year/month/

  site-visits/
    lead-id/
      visit-id/

  imports/
    import-id/

  employees/
    employee-id/
```

Requirements:

- Private S3 bucket.
- Block public access.
- Enable encryption at rest.
- Use least-privilege IAM permissions.
- Prefer IAM roles instead of hardcoded AWS credentials.
- Validate MIME type, extension, size, and file signatures.
- Generate unique object keys.
- Prevent path traversal.
- Use presigned URLs with short expiration.
- Verify authorization before issuing upload or download URLs.
- Track file ownership and purpose in MongoDB.
- Confirm uploaded object metadata before associating files with reports.
- Reject unauthorized file attachment references.
- Support orphaned upload cleanup.
- Define file retention and deletion policies.
- Consider malware scanning for untrusted uploads.

Do not store image binaries in MongoDB.

Do not return public S3 URLs for sensitive employee photographs.

---

## 15. Authentication and Security

Implement production-grade authentication.

### Authentication APIs

```http
POST /api/v1/auth/login
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
POST /api/v1/auth/logout-all
POST /api/v1/auth/change-password
POST /api/v1/auth/forgot-password
POST /api/v1/auth/reset-password
GET /api/v1/auth/me
```

Requirements:

- Argon2id password hashing.
- Short-lived JWT access tokens.
- Refresh-token rotation.
- Hashed refresh-token storage.
- Session revocation.
- Secure logout.
- Password reset with expiring single-use tokens.
- Rate-limited login.
- Brute-force protection.
- Account deactivation checks.
- Token verification with explicit algorithm, issuer, and audience.
- Secret management through environment variables or a secret manager.
- Authorization state invalidation after permission changes.

For browser clients, prefer HttpOnly, Secure, SameSite cookies for refresh tokens.

Implement appropriate CSRF protection for cookie-authenticated state-changing requests.

Never store long-lived authentication tokens in localStorage.

### Application security

Implement:

- Helmet security headers
- Strict CORS allowlist
- Request body size limits
- Joi validation
- Input sanitization
- MongoDB operator injection prevention
- Prototype pollution defenses
- Secure error responses
- Request rate limiting
- Sensitive-data redaction
- Dependency vulnerability checks
- Audit logging
- Strong permission enforcement
- Object-level authorization
- Safe CSV processing
- Secure file upload validation

Never trust `userId`, `roleId`, or `branchId` sent by the frontend for determining the authenticated identity.

---

## 16. Activity and Audit Logs

Create `activity_logs`.

Track important actions:

```text
LOGIN
LOGOUT
EMPLOYEE_CREATED
EMPLOYEE_UPDATED
ROLE_CREATED
ROLE_UPDATED
PERMISSION_CHANGED
ATTENDANCE_MARKED
ATTENDANCE_CORRECTED
CUSTOMER_IMPORTED
LEAD_CREATED
LEAD_ASSIGNED
LEAD_STATUS_CHANGED
REPORT_SUBMITTED
TARGET_CREATED
TARGET_UPDATED
FILE_UPLOADED
```

Suggested fields:

```text
actorId
action
entityType
entityId
timestamp
ipAddress
userAgent
requestId
metadata
```

For sensitive changes, record appropriately redacted before/after values.

Never log passwords, tokens, secrets, or unnecessary sensitive customer information.

Use append-only audit events and restrict modification permissions.

---

## 17. State, District and Block Master Data

Create:

```text
states
districts
blocks
```

Relationships:

```text
State
  └── District
        └── Block / Tehsil
```

API examples:

```http
GET /api/v1/locations/states
GET /api/v1/locations/districts?stateId=...
GET /api/v1/locations/blocks?districtId=...
```

Use reference collections rather than repeatedly storing location names.

Support authenticated admin management of master data.

Validate that the selected district belongs to the selected state and that the selected block belongs to the selected district.

---

## 18. Solar Installation and AMC Expansion

Design the database so the software can later support:

- Solar installation projects
- Customer quotations
- Site surveys
- Installation scheduling
- Installation engineers
- Project status tracking
- AMC contracts
- AMC renewals
- Service visits
- Maintenance reports
- Customer service history

Do not implement unnecessary full AMC functionality in the initial development phase.

Provide a documented future-ready schema design and module boundaries.

---

## 19. API Response Standards

Use a consistent response format.

Successful response:

```json
{
  "success": true,
  "message": "Operation completed successfully",
  "data": {},
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 100,
    "totalPages": 5
  }
}
```

Error response:

```json
{
  "success": false,
  "message": "Access denied",
  "error": {
    "code": "FORBIDDEN",
    "details": []
  }
}
```

Use appropriate HTTP status codes.

Do not expose stack traces in production.

Implement centralized error handling with typed application errors.

---

## 20. Performance and Database Optimization

Implement:

- Appropriate MongoDB indexes
- Compound indexes for common filters
- Lean queries for read-only responses
- Aggregation pipelines for dashboards
- Projection to avoid exposing sensitive fields
- Cursor-based pagination for large datasets where appropriate
- Redis caching for suitable dashboard summaries
- Cache invalidation strategies
- Bulk operations for imports
- Background processing for expensive jobs
- Graceful shutdown
- Database connection pooling
- Query performance monitoring

Avoid unnecessary MongoDB `populate()` chains and N+1 query patterns.

Use MongoDB transactions where atomic multi-document operations are required.

Document replica-set requirements for transactions.

---

## 21. Testing Requirements

Write meaningful tests for all critical modules.

Prioritize:

1. Authentication and token rotation.
2. Role and permission authorization.
3. Employee creation restrictions.
4. Hierarchy traversal and circular relationship prevention.
5. Branch-level data isolation.
6. Cross-employee access prevention.
7. Attendance duplicate prevention.
8. Attendance location validation.
9. S3 upload authorization.
10. CSV import validation.
11. Duplicate lead conversion prevention.
12. Lead assignment authorization.
13. Target calculation.
14. Dashboard data scope enforcement.
15. Deactivated employee access.
16. Permission changes during active sessions.

Test both successful and forbidden operations.

Include security tests for IDOR (insecure direct object reference) and privilege escalation.

---

## 22. Development Phases

Do not generate the entire application in one giant response.

Implement the backend in carefully planned phases.

### Phase 1 — Foundation

- Initialize project
- Configure TypeScript
- Configure Express
- Configure MongoDB
- Configure environment validation
- Configure logging
- Configure error handling
- Configure Joi validation middleware
- Configure security middleware
- Configure API response helpers
- Configure testing infrastructure
- Configure Swagger
- Configure Docker

### Phase 2 — Authentication and Authorization

- User model
- Role model
- Permission model
- Permission registry
- MD bootstrap
- Authentication
- Refresh sessions
- Dynamic RBAC
- Scope authorization
- Security tests

### Phase 3 — Employee Hierarchy and Branches

- Employee CRUD
- Branch CRUD
- Reporting manager relationships
- Subtree query service
- Employee creation policies
- Employee transfer
- Hierarchy APIs
- Scope tests

### Phase 4 — Attendance

- Attendance schema
- S3 photo upload
- Check-in
- Check-out
- GPS validation
- Attendance history
- Attendance summary
- Attendance review
- Attendance filters

### Phase 5 — Customers, CSV and Leads

- Customer model
- CSV import pipeline
- Duplicate detection
- Customer assignment
- Lead creation
- Lead conversion
- Lead assignment history
- Lead status workflow
- Lead filtering

### Phase 6 — Reporting

- Telecaller call activities
- Telecaller daily reporting
- Sales executive site visits
- Site photographs
- GPS visit coordinates
- Reporting review
- Report history

### Phase 7 — Target Management

- Target creation
- Target assignment
- Actual activity calculations
- Target achievement
- Target summaries
- Target reports

### Phase 8 — Advanced Dashboards

- MD dashboard
- BDO dashboard
- MH dashboard
- BH dashboard
- SEx dashboard
- TC dashboard
- Branch analytics
- Employee performance
- Conversion funnel
- Date range comparisons
- CSV exports

### Phase 9 — Production Readiness

- Integration testing
- Security testing
- Performance optimization
- Docker deployment
- Health checks
- Production configuration
- Documentation
- API examples
- Database indexes
- Operational monitoring

---

## 23. Coding Standards

Follow these requirements strictly:

- Use TypeScript strict mode.
- Avoid `any`.
- Use ESM consistently.
- Follow SOLID principles.
- Prefer dependency injection where useful.
- Keep controllers thin.
- Separate business logic from database access.
- Use reusable Joi schemas.
- Use centralized authorization services.
- Never duplicate authorization logic across controllers.
- Do not hardcode secrets.
- Avoid unnecessary dependencies.
- Do not swallow errors.
- Use structured logging.
- Use consistent naming.
- Use UTC timestamps in MongoDB.
- Apply Asia/Kolkata timezone for business-day calculations.
- Implement secure defaults.
- Write readable, maintainable code.
- Add comments only where business logic requires explanation.
- Create indexes and validate uniqueness.
- Avoid overengineering.

All APIs must be versioned under:

```text
/api/v1
```

---

## 24. Documentation Deliverables

Create the following files:

```text
README.md
ARCHITECTURE.md
DATABASE_DESIGN.md
RBAC_DESIGN.md
API_DOCUMENTATION.md
SECURITY.md
ENVIRONMENT_SETUP.md
DEPLOYMENT.md
DEVELOPMENT_ROADMAP.md
```

Include:

- Setup instructions
- Required environment variables
- MongoDB setup
- AWS S3 setup
- Redis setup
- MD bootstrap instructions
- API endpoint descriptions
- Sample requests and responses
- Authorization matrix
- Database relationships
- Development and testing commands
- Docker instructions
- Production deployment guidance

---

## 25. Important Architectural Decisions

Before implementation, explicitly address the following:

1. How custom roles fit into the employee hierarchy.
2. How manager/subordinate relationships are stored and queried.
3. How RBAC permissions interact with branch and subtree scopes.
4. How BH branch access differs from reporting-subtree access.
5. Whether employees may have multiple roles or branches.
6. How permissions are invalidated after changes.
7. How reassignment affects historical records.
8. How duplicate CSV customer records are handled.
9. How telecallers assign or propose leads to SEx.
10. How attendance photo and GPS evidence is validated.
11. How targets are calculated from actual activities.
12. How sensitive customer and employee data is protected.
13. How to handle concurrent lead assignments.
14. How to manage configurable lead status transitions.
15. How dashboards avoid leaking unauthorized aggregate data.

Use safe, well-documented assumptions for unspecified behavior.

For decisions with significant business consequences, document the alternatives and recommend a default rather than silently inventing a policy.

---

## 26. How You Must Work

Follow these steps:

**Step 1:** Analyze all project requirements.

**Step 2:** Identify missing requirements, ambiguities, security risks, and important business rules.

**Step 3:** Design the system architecture and explain the modules.

**Step 4:** Design all MongoDB collections, field types, relationships, indexes, and validation rules.

**Step 5:** Design the RBAC permission matrix and employee hierarchy authorization.

**Step 6:** Design the REST API specification.

**Step 7:** Create the complete folder structure and development roadmap.

**Step 8:** Begin implementation with Phase 1 only.

**Step 9:** After implementing Phase 1, run linting, type checking, and available tests, and fix any failures.

**Step 10:** Summarize files created, decisions made, test results, and remaining work.

**Step 11:** Wait for my approval before starting Phase 2.

For each subsequent phase, implement real working code rather than pseudocode.

Do not claim code is complete unless it has been written and verified.

If external credentials or services are unavailable, provide a safe configuration example and clearly identify what could not be tested.

### Final instruction

I want a real, production-oriented backend for Sunvika Pvt. Ltd., not a basic CRUD tutorial.

Prioritize **security, maintainability, dynamic RBAC, hierarchy-based data access, branch-level authorization, accurate reporting, GPS-based attendance evidence, secure file storage, and scalable dashboard APIs**.

Start by analyzing the requirements and producing the architecture, database design, RBAC design, API specification, and phased roadmap. Then implement Phase 1 only.
