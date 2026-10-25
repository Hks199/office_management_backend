# REST API specification

Base path `/api/v1`. **Phases 1-9 are implemented.** Health, identity, roles/policies, employees/hierarchy, branches, location masters, attendance, private files, customers/imports/leads, reports, targets, dashboards and operational metrics work as documented. Swagger at `/api/v1/docs/` and JSON at `/api/v1/openapi.json` describe implemented endpoints; both are disabled unless explicitly enabled outside production. General notifications and generic audit browsing remain future contracts.

## Runtime endpoints

Phase 9 adds GET `/operations/metrics`, requiring live settings:manage ALL and rejecting query parameters. Standard success data contains observedAt, process HTTP/memory/CPU/event-loop counters, safe observed DB/pool counters and shared queue status/count/oldestCreatedAt groups. No customer/job payloads, identities, ciphertext or provider metadata are returned. It is no-store, checks authorization before and after observations, and is intended for restricted periodic monitoring. See PHASE9.md for the response example and counter semantics. Shared quota failures can return 503 RATE_LIMIT_UNAVAILABLE; exhausted quotas retain 429 RATE_LIMITED/AUTH_RATE_LIMITED.

| Method | Path | Access | Result |
|---|---|---|---|
| GET | /health/live | Public | 200 process alive |
| GET | /health/ready | Public | 200 database ping succeeds; 503 disconnected/draining |
| GET | /openapi.json | Development opt-in | OpenAPI 3.0.3 document |
| GET | /docs/ | Development opt-in | Swagger UI |

```sh
curl http://localhost:3000/api/v1/health/live
```

```json
{"success":true,"message":"Service is alive","data":{"status":"ok"}}
```

Readiness failures return `{"success":false,"message":"Service is not ready","error":{"code":"SERVICE_UNAVAILABLE","details":[]}}`. `X-Request-Id` is returned on all application responses. Health reveals no database addresses, environment values, employee information or versions.

## Common API contract

Bearer access JWT for protected endpoints; refresh tokens are HttpOnly/Secure/SameSite cookies, limited to `/api/v1/auth`. Cookie mutations require exact allowed Origin and a session-bound CSRF header. No public employee registration. Login/reset responses never include password hashes or session hashes. JSON DTOs reject unknown fields and Mongo operators. Body limit defaults to 100 KiB; uploads stream directly to private S3 after an authorized intent.

Success: `{success:true,message,data,meta?}`; lists use `data:[]`, `meta:{page,limit,total,totalPages}`. Failures: `{success:false,message,error:{code,details:[{field,code}]}}`. 201 for creates, 200 for updates/logout (consistent envelope), 202 for queued jobs; 400 invalid input, 401 invalid credentials/session, 403 missing action, 404 missing/invisible object, 409 duplicate/stale revision/invalid transition, 413 body too large, 415 unsupported encoding/media, 429 throttled, 503 unavailable. No raw Joi values or stack traces are returned.

Example implemented employee request (requires appropriate scope and an approved role template):

```http
POST /api/v1/employees
Authorization: Bearer <access-token>
Content-Type: application/json

{"employeeCode":"SV-0002","firstName":"Anita","lastName":"Kumar","email":"anita@example.invalid","mobileNumber":"+919876543210","roleId":"<24-hex-id>","branchId":"<24-hex-id>","reportingManagerId":"<24-hex-id>","dateOfJoining":"2026-10-17T00:00:00Z"}
```

Expected 201: `{success:true,message:"Employee created",data:{_id:"…",employeeCode:"SV-0002",invitationStatus:"PENDING"}}`. An invitation token is delivered through an approved secure channel, never a plaintext password. Missing role permission returns `{success:false,message:"Access denied",error:{code:"FORBIDDEN",details:[]}}`.

Lists accept `page` (1–10000), `limit` (1–100), allowlisted `sortBy`, `sortOrder` (asc/desc), `search` (2–100 bounded literal characters), ISO `startDate/endDate`, and module-specific filters below. Date ranges are half-open and end must follow start. Reject excessive ranges (recommended 366 days) for interactive dashboards. Search is escaped prefix/text-index search, not client regex. Large exports use cursor batches and a background job, never unbounded synchronous list queries. Cursor pagination binds cursor to actor scope/filter and stable `(createdAt,_id)` ordering. Filters always intersect permission scope.

## Implemented Phase 2: authentication, roles and policies

| Method / route | Input / output | Permission |
|---|---|---|
| POST /auth/login | `{email,password}` → short-lived accessToken, expiresIn seconds, session-bound csrfToken; GET /auth/me for profile; sets rotating refresh cookie | Public, throttled |
| POST /auth/refresh | refresh cookie + CSRF header → accessToken and rotated cookie | Active refresh session |
| POST /auth/logout | refresh cookie + CSRF → revoke session/family, clear cookie | Session |
| POST /auth/logout-all | → revoke all employee sessions, clear cookie | Authenticated self |
| POST /auth/change-password | `{currentPassword,newPassword}` → change hash and revoke sessions | Authenticated self |
| POST /auth/forgot-password | `{email}` → identical generic 202 whether known or not | Public, throttled |
| POST /auth/reset-password | `{token,newPassword}` → atomically consume token and revoke sessions | Valid single-use token |
| POST /auth/accept-invitation | `{token,newPassword}` → initial credential setup | Valid invitation token |
| GET /auth/csrf | refresh cookie + required Origin -> recover session-bound csrfToken | Active refresh session |
| GET /auth/me | → safe profile and effective grants | Active session |
| GET /roles | paginated active/custom roles | roles:read |
| POST /roles | `{name,code,description?,permissions:[{permissionId,scope}]}` | roles:create ALL + delegation checks |
| GET /roles/:id | → safe role definition | roles:read |
| PATCH /roles/:id | `{revision,name?,description?,permissions?,isActive?}` | roles:update; permissions:assign for grants; delegate_sensitive for sensitive/ALL grants |
| DELETE /roles/:id | `{revision}` JSON body; archive unused custom role; reject system/in-use roles | roles:delete |
| GET /permissions | controlled registry definitions, allowed scopes, sensitive flags | permissions:read |
| GET /role-creation-policies | allowed creator/target/manager relationships | policies:manage |
| PUT /role-creation-policies/:id | `{revision,allowedManagerRoleIds,branchRule,allowCrossBranchReporting,isActive}` | policies:manage |
| POST /role-creation-policies | `{creatorRoleId,targetRoleId,...policy}` | policies:manage |

Configured default access lifetime is 10 minutes; refresh sliding lifetime 7 days, absolute lifetime 30 days; reset/invitation expire in 30 minutes/24 hours. Refresh replay revokes family; clients serialize refresh requests. Invalid login errors do not distinguish unknown/inactive accounts.

## Implemented Phase 3: employees, branches and master data

| Method / route | Input / output | Permission |
|---|---|---|
| POST /employees | creation DTO above; no client hash or grants | users:create + policy |
| GET /employees | filters branchId,managerId,roleId,isActive,employmentStatus,search | users:read |
| GET /employees/hierarchy | bounded graph for authorized root; paginated descendants | hierarchy:read |
| GET /employees/downlines | managerId?,depth? (1–20), paginated list | hierarchy:read |
| GET /employees/:id | safe profile | users:read |
| PATCH /employees/:id | `{revision,firstName?,lastName?,designation?,department?,...profile}`; role excluded | users:update |
| PATCH /employees/:id/role | `{revision,roleId,reason}` | roles:assign + policy |
| PATCH /employees/:id/status | `{revision,isActive,employmentStatus,reason}` | users:deactivate |
| PATCH /employees/:id/manager | `{revision,reportingManagerId,reason}` | users:change_manager |
| PATCH /employees/:id/branch | `{revision,branchId,reportingManagerId,reason}` | users:transfer |
| GET /branches; GET /branches/:id | filters stateId,districtId,isActive,search | branches:read |
| POST /branches | `{branchCode,branchName,address,stateId,districtId,blockId?,contactNumber}` | branches:create |
| PATCH /branches/:id | `{revision,...branchProfile}` | branches:update |
| PATCH /branches/:id/head | `{revision,branchHeadId,reason}` | branches:assign_head |
| GET /locations/states | active states | locations:read |
| GET /locations/districts | required stateId | locations:read |
| GET /locations/blocks | required districtId | locations:read |
| POST /locations/{states,districts,blocks} | `{code,name,parentId?,kind?}` | locations:manage |
| PATCH /locations/{states,districts,blocks}/:id | `{revision,name?,isActive?}`; prevent invalidating referenced hierarchy | locations:manage |

Static employee routes are registered before `/:id`. Location fields validate the complete state→district→block chain. Employees deactivate, never delete. Branch changes require both source/destination scope and active-manager eligibility; branch head reassignment is explicit.

## Implemented Phase 4: attendance and private photos

All routes below require live bearer authentication and return no-store responses. See [PHASE4.md](PHASE4.md) for defaults, evidence limitations, S3 setup and examples. Version 0.4.0 OpenAPI includes every runtime contract.

| Method / route | Input / output | Permission |
|---|---|---|
| POST /files/upload-intents | `{purpose,filename,contentType,size,checksumSHA256}` ? `{fileId,expiresAt,upload:{method:"POST",url,fields},instructions}` | files:upload + attendance:create; authenticated owner only |
| POST /files/:id/confirm | no body; verify S3 metadata/checksum/signature/version ? safe metadata | files:upload + owner |
| GET /files/:id/download | `{url,expiresInSeconds:60}` | files:read SELF/ALL + parent attendance:read |
| POST /attendance/check-in | `{photoFileId,capturedAt,location:{latitude,longitude,accuracyMeters?}}` ? record (201) | attendance:create SELF |
| POST /attendance/check-out | same evidence DTO; close own open record within 24 hours (200) | attendance:create SELF |
| GET /attendance/me | monthly own records, paginated | attendance:read intersected with actor ID |
| GET /attendance | monthly scoped history, paginated | attendance:read |
| GET /attendance/summary | `{month,timezone,days:[{_id,records,completed,pendingReview,rejected,lateArrivals,earlyExits,workedMinutes}]}` | attendance:read applied before aggregation |
| GET /attendance/employee/:id | monthly calendar records, path employee overrides query | attendance:read |
| GET /attendance/branch/:id | monthly branch records, path branch overrides query | attendance:read |
| GET /attendance/:id/photos/check-in | short-lived confirmed-version URL | parent attendance:read |
| GET /attendance/:id/photos/check-out | same; 404 when no original checkout photo | parent attendance:read |
| PATCH /attendance/:id/review | `{revision,reviewStatus,reason}` | attendance:review; no self review |
| POST /attendance/:id/corrections | `{revision,effectiveCheckInAt,effectiveCheckOutAt,reason}` | attendance:correct; no self correction |

Upload purposes: ATTENDANCE_CHECK_IN / ATTENDANCE_CHECK_OUT. JPEG/PNG/WebP only, 12 bytes?5 MiB; filename extension must match contentType. SHA-256 is standard base64 of 32 digest bytes. Submit every signed S3 POST form field, then append the file last. Upload/confirmation/attachment must complete within five minutes. Each file attaches once, by its owner, for its issued purpose. S3 versioning and encryption plus all public-access blocks are mandatory; no public object URLs.

History/summary filters: `month=YYYY-MM` (2000?2099, default current Kolkata month), employeeId, branchId, status=OPEN/COMPLETED, reviewStatus=PENDING/APPROVED/REJECTED, lateArrival, earlyExit. Lists use page 1..10000, limit 1..100 (default20), sortOrder asc/desc (defaultdesc), date/ID ordering. Summary ignores pagination and includes only dates with matching records. Worked minutes use completed effective intervals, excluding REJECTED; filter APPROVED for approved totals. Missing dates are not inferred absences.

Branch create/update now accepts attendancePolicy. Use the complete replacement object `{startMinute:null,endMinute:null,graceMinutes:0,maxAccuracyMeters:100,maxCaptureAgeSeconds:300,geofence:null}` or a validated same-day schedule/geofence. Policy changes require branches:update ALL and expected branch revision. Policy snapshots preserve meaning across branch changes. GPS/capture anomalies are review flags, not proof of presence. Raw evidence never changes during effective-time corrections. Every correction/review has a mandatory 3?500 character reason and atomic immutable audit. No automatic deletion of attached evidence is configured.

Example check-in after upload confirmation:

```json
{"photoFileId":"0123456789abcdef01234567","capturedAt":"2026-10-17T09:00:00+05:30","location":{"latitude":22.5726,"longitude":88.3639,"accuracyMeters":12}}
```

## Implemented Phase 5: customers, CSV imports and leads

Version 0.8.0 OpenAPI documents every runtime DTO. [PHASE5.md](PHASE5.md) covers setup, scope semantics, defaults, worker recovery, retention and examples. All routes require live bearer sessions and return no-store responses.

| Method / route | Input / behavior | Permission |
|---|---|---|
| POST /csv-imports/upload-intents | `{filename,size,checksumSHA256}` -> exact-size private signed POST | imports:create + leads:import + files:upload |
| POST /csv-imports/files/:id/confirm | owner HEAD/checksum/version confirmation; full CSV validated by worker | same |
| POST /csv-imports | `{fileId,branchId,columnMapping?}` -> queued validation (202) | imports:create + leads:import, current branch scope |
| GET /csv-imports; GET /csv-imports/:id | scoped job progress/counts; creator access while action remains granted | imports:read |
| GET /csv-imports/:id/rows | complete preview, page/limit/status; current branch eligibility | imports:read |
| POST /csv-imports/:id/confirm | `{revision,assignedTo}` -> queued commit (202); same-assignee FAILED confirmed jobs can resume | imports:confirm + leads:import + customers:assign |
| GET /customers; GET /customers/:id | assigned/creator/team/branch scoped customer records | customers:read |
| PATCH /customers/:id/status | `{revision,status,reason}`; AVAILABLE/INTERESTED/NOT_INTERESTED | current caller or customers:assign manager |
| POST /customers/assignments | `{items:[{id,revision}],assignedTo,reason}`; atomic 1-100 unique IDs | customers:assign; old/new scope + recipient eligibility |
| GET /customers/:id/assignments | bounded parent-authorized history | customers:read |
| POST /customers/:id/convert | `{revision,requirements,proposedSalesExecutiveId?}` plus Idempotency-Key | leads:create + customers:read, both scoped to source |
| POST /leads | contact/branch/location/requirements DTO, optional assignedTo; server computes value | leads:create; assigning another employee also needs leads:assign |
| GET /leads; GET /leads/:id | scope-filtered leads and decimal-string values | leads:read |
| PATCH /leads/:id | `{revision,...contact/requirements}`; no branch/assignee/status/computed field | leads:update |
| POST /leads/:id/assignments | `{revision,assignedTo,reason}` -> canonical current assignment + immutable history | leads:assign with old/new scope |
| GET /leads/:id/assignments | bounded parent-authorized history | leads:read |
| POST /leads/:id/assignment-proposals | `{revision,assignedTo,reason}`; same-branch recommendation, not direct assignment | leads:propose_assignment + parent read |
| GET /leads/:id/assignment-proposals | bounded parent-authorized proposals | leads:read |
| PATCH /lead-assignment-proposals/:id | `{status:APPROVED|REJECTED,reason}`; expiry/revision/source/destination rechecked | leads:assign |
| PATCH /leads/:id/status | `{revision,status,reason}`; pinned workflow/hold/resume | leads:update; leads:reopen for terminal reopen |
| GET /leads/:id/status-history | immutable events, conversion value as a decimal string | leads:read |
| POST /leads/exports | validated lead filters or `{}` -> private background export (202) | leads:export intersected with leads:read |
| GET /leads/exports/:id | owner-only job metadata | leads:export |
| GET /leads/exports/:id/download | owner/live grants/every included lead rechecked; 60-second URL | leads:export + leads:read |
| GET /lead-workflows | latest immutable version; existing leads retain their version | leads:read |
| POST /lead-workflows | `{expectedVersion,transitions:[{from,to}]}` | settings:manage ALL |
| GET /reference-values | required category, optional isActive (default true) | locations:read ALL |
| POST /reference-values | `{category,code,label}` | settings:manage ALL |
| PATCH /reference-values/:id | `{revision,label?,isActive?}`; code/category immutable | settings:manage ALL |
| GET /commercial-settings | duplicateScope BRANCH/COMPANY + revision | settings:manage ALL |
| PATCH /commercial-settings | `{revision,duplicateScope}`; policy freezes after first customer | settings:manage ALL |

Requirements: `{requiredCapacityKw:"5.00",ratePerKw:"55000.00",paymentMode:"configured-code",panelBrand:"configured-code",panelTechnology:"configured-code",leadSource:"configured-code",nextFollowUpAt?:ISO|null}`. All reference codes must be active; server computes estimatedProjectValue `"275000.00"` using exact decimal arithmetic. Codes normalize uppercase. Numeric/scientific/negative/overprecision quantities and supplied calculated values are rejected.

Main-list filters: branchId, assignedTo, createdBy, stateId/districtId/blockId, valid resource status (one scalar), literal name/mobile prefix search, startDate/endDate (half-open createdAt range), followUpFrom/followUpTo, leadSource; page1..10000/limit1..100, createdAt+ID sort asc/desc. End must exceed start. Customers use AVAILABLE/INTERESTED/NOT_INTERESTED/CONVERTED; lead statuses are the controlled workflow enum. History endpoints use page/limit and return bounded arrays. Date-only shared validators mean UTC midnight; use explicit-zone timestamps for business-time boundaries.

CSV: UTF-8/BOM with quoted commas/newlines, 20 MiB, 50000 rows, 16 columns, 2000 chars/cell and bounded record buffers. Default headers: Customer Name, Mobile Number, Alternate Number, State, District, Block/Tehsil, Site Address, Remarks. Custom mappings may omit optional headers. Preview has no live customers; confirmation selects an eligible customer-calling assignee and bounded transactional batches become visible progressively. Per-row rowErrors contain safe codes. Duplicate report defaults to normalized phone within branch; COMPANY mode reveals no conflicting customer details. Worker rechecks current authority, policy and active references before publication/commit.

Eligible calling/sales recipients require dedicated customers:receive_assignment SELF / leads:receive_assignment SELF, assigned-read capability, ACTIVE employment and same branch. Existing role grants are not silently changed by migration; see the explicit capability rollout command and policy reapproval steps in PHASE5.md. Canonical assignedTo drives current authorization; salesExecutiveId is historical attribution. TC's explicit creator SELF read can retain originated lead visibility. Unassigned leads require creator SELF, BRANCH or ALL access, not inferred subtree membership.

Default workflow: NEW to ASSIGNED/CONTACTED, ASSIGNED to CONTACTED, CONTACTED to INTERESTED/NOT_INTERESTED, INTERESTED to QUALIFIED to SITE_VISIT_SCHEDULED to SITE_VISITED to QUOTATION_SENT, then NEGOTIATION/CONVERTED; NEGOTIATION to CONVERTED/LOST. Working stages can hold or lose with reason. Hold resumes only its saved stage; terminal reopening requires scoped leads:reopen and returns to CONTACTED. Assignment never silently regresses status. Exports neutralize spreadsheet formulas and are capped at 5000 rows/10 MiB. No verified call/site/target activity is inferred from a lead-stage change.

## Implemented Phase 6: activity and reporting

| Method / route | Input / output | Permission |
|---|---|---|
| POST /telecaller-reports/calls | `{customerId,callStartedAt,callEndedAt,callOutcome,customerInterest,followUpAt?,remarks?}` + Idempotency-Key | reports:create + assigned customer |
| GET /telecaller-reports/calls | employeeId,customerId,callOutcome,reviewStatus,date range | reports:read |
| GET /telecaller-reports/daily | derived daily aggregates | reports:read |
| PATCH /telecaller-reports/calls/:id/review | `{revision,reviewStatus,remarks}` | reports:review |
| POST /sales-reports/visits | `{leadId,location,clientCapturedAt}` + Idempotency-Key → visit start | reports:create + assigned lead |
| PATCH /sales-reports/visits/:id/complete | `{revision,photoFileIds,location,clientCapturedAt,discussionNotes,customerInterest,installationReadiness,visitOutcome,requiredCapacityKw,nextFollowUpAt?}` | reports:create SELF + lead access |
| GET /sales-reports/visits; GET /sales-reports/visits/:id | employeeId,leadId,branchId,visitOutcome,reviewStatus,date range | reports:read |
| PATCH /sales-reports/visits/:id/review | `{revision,reviewStatus,remarks}` | reports:review |

Actor and server timestamps are authoritative; validate client intervals, reject negative/future/impossible durations, calculate duration server-side. A report does not itself prove a phone call occurred. Approved verification policy determines which events count toward targets. Sales visit location response retains `{latitude,longitude}` for map clients; geospatial queries use authorized scope plus GeoJSON `[longitude,latitude]`.

## Implemented Phase 7: targets

| Method / route | Input / output | Permission |
|---|---|---|
| POST /targets | `{employeeId,targetType,targetValue,periodType,startDate,endDate}` | targets:create |
| GET /targets; GET /targets/:id | employeeId,branchId,targetType,status,period/date filters | targets:read |
| PATCH /targets/:id | `{revision,targetValue?,startDate?,endDate?,status?,reason}` | targets:update |
| GET /targets/:id/progress | `{targetValue,actualValue,achievementPercentage,asOf}` | targets:read + verified source scope |
| GET /targets/:id/revisions | definition history | targets:read |
| GET /targets/summary | employee/type/period aggregations | targets:read |

Periods are DAILY/WEEKLY/MONTHLY/CUSTOM, converted from business-time boundaries to UTC. Weeks start Monday; dates are Kolkata business days with exclusive endDate. Values and uncapped achievement percentages serialize as exact decimal strings; see PHASE7.md for approved evidence and attribution policies. CALLS_COMPLETED counts verified ended call IDs; CONNECTED_CALLS verified connected outcome IDs; LEADS_GENERATED distinct authorized originated lead IDs; SITE_VISITS verified completed visit IDs; QUALIFIED_LEADS distinct first verified qualification per lead; CONVERSIONS distinct first verified conversion per lead; SALES_VALUE sums that conversion's frozen server value. Reopening must not create duplicate achievements. `targetValue > 0 ? actualValue / targetValue * 100 : 0`, without a 100% cap. Same verified data drives target reports and dashboards.

## Implemented Phase 8 analytics and future audit/notification contracts

| Method / route | Result | Permission |
|---|---|---|
| GET /dashboard/overview | scoped employee/branch/attendance/customer/lead/visit totals and pending work | dashboard:read + each source grant |
| GET /dashboard/attendance | present/absent/late/monthly calendar | same + attendance:read/users:read |
| GET /dashboard/leads | pending,interested,converted,follow-ups,conversion rate | same + leads:read |
| GET /dashboard/targets | actuals,targets,uncapped percentages | same + targets:read + source grants |
| GET /dashboard/employee-performance | calls,visits,conversions,targets by scoped employee | same + reports:read/users:read |
| GET /dashboard/branch-performance | scoped branch breakdown | same + branches:read |
| GET /dashboard/lead-funnel | stage counts and conversion percentage | same + leads:read |
| GET /dashboard/trends | monthly buckets and previous-period comparisons | same + source grants |
| POST /dashboard/exports | asynchronous CSV export of authorized metrics | dashboard:export + source grants |
| GET /activity-logs (future, not implemented) | actorId,action,entityType,entityId,date range; append-only | activity_logs:read |
| GET /notifications (future, not implemented) | own unread/read notifications | notifications:read SELF |
| PATCH /notifications/:id/read (future, not implemented) | mark own notification read | notifications:update SELF |

Shared dashboard routes adapt to effective grants, not role-name switches. MD gets company totals; BDO/MH get current descendants; BH gets branch data; SEx/TC get personal assigned work and verified activity. Include recent visits/calls, calling outcomes, import statistics, follow-ups, top employees, branch/role breakdowns and target trends only if source scopes allow them. Attendance absence uses active eligible employees and configured working days, not `totalEmployees - allAttendanceRows`. Aggregation starts with scoped `$match` for every source and lookup. Comparison windows share identical scope and business timezone. CSV export files require reauthorization at download.

## Phase 2 browser/API usage

Login sends `{email,password}` and returns `{success:true,message:"Authenticated",data:{accessToken,csrfToken,expiresIn:600}}` while setting `sunvika_refresh`. Refresh tokens are never in JSON. API cookies are HttpOnly, SameSite=Strict, Path=/api/v1/auth and Secure in production; deploy frontend/API on the same site. Fetch with `credentials:"include"`. Refresh/logout additionally send `Origin` and `X-CSRF-Token`; a wrong CSRF/session binding returns 401, absent Origin/header returns 403. GET /auth/csrf needs cookie and allowed Origin to recover CSRF state after reload. Bearer-only logout-all/change-password do not rely on cookies for identity.

Do not save long-lived tokens in localStorage. Keep access tokens in memory, serialize refresh requests, and clear local auth state on 401. Concurrent reuse of one refresh token intentionally revokes the entire family, including the successful replacement. Logout revokes its family; logout-all and password changes revoke all employee sessions. Tokens check explicit HS256, issuer, audience, type and expiry plus current user/session/role state.

Role grants request shape is `{permissionId:"24-hex-id",scope:"SELF"}`; get IDs from GET /permissions. Role creation starts with no grants unless explicitly provided. Permission definitions cannot be created through HTTP. PATCH role requires expected revision and one mutable field; DELETE requires `{revision}` and archives only unused custom roles. PUT policy replaces the full policy fields including creatorRoleId,targetRoleId,allowedManagerRoleIds,branchRule,allowCrossBranchReporting,isActive plus revision. All administration actions require their ALL-scoped grant. Role/policy pagination uses page/limit and total metadata. Roles support name-prefix search, name/createdAt sorting and isActive. Policies support isActive, creatorRoleId, targetRoleId and createdAt sortOrder; unsupported filters are rejected.

Recovery returns a generic 202 for unknown/inactive/eligible accounts; eligible tokens are queued encrypted for the SMTP worker. Requests do not synchronously send email. Live delivery requires a configured worker and frontend reset/setup pages. Tokens remain single-use even if a delivery retry duplicates a message. No password or token is printed by bootstrap or worker commands.

## Phase 3 contract details

See PHASE3.md for complete examples. Employee creation requires explicit branchId (ObjectId or null only for an approved company-wide role), reportingManagerId, roleId, employeeCode, names, normalized email/E.164 mobile and dateOfJoining. Initial passwords/hashes are rejected. Response uses _id, revision and invitationStatus:PENDING; no password, token, authVersion or bootstrap marker is exposed. Invitations are queued asynchronously through the existing credential worker.

PATCH employee accepts only profile fields plus revision. Dedicated /manager, /branch, /role and /status patches require revision and reason. /status requires isActive and employmentStatus (ACTIVE/ON_LEAVE/EXITED); active EXITED combinations fail validation. /branch also requires reportingManagerId, so branch and manager change atomically. Root manager/branch/role changes are prohibited. No DELETE employee/branch endpoint exists: use soft status/deactivation to preserve history.

List employees supports branchId,managerId,roleId,isActive,employmentStatus,department,search,startDate,endDate,page,limit,sortBy,sortOrder. Date filters refer to createdAt, inclusive start/exclusive end. Sort fields are employeeCode,firstName,createdAt,dateOfJoining. Search is escaped prefix matching of names/code/email/mobile. Dates accept valid calendar dates (UTC midnight) or ISO timestamps with explicit Z/offset; timezone-less timestamps are rejected. Counts and pages always intersect scope.

Hierarchy/downlines accept the same filters plus depth (1-20) and rootId or managerId as a mutually exclusive anchor. Default anchor is the actor. /hierarchy includes the root only if visible; /downlines excludes it. Both return paginated flat nodes with hierarchyDepth; managerId is the anchor here, not an additional immediate-manager filter. A page can omit a parent and is not a complete nested tree. hierarchy:read and users:read are both required.

Branches support isActive,stateId,districtId,blockId,search,page,limit,sortBy(branchName/branchCode/createdAt),sortOrder. BH may edit branchName,address,contactNumber in scope; location and activation changes require branches:update ALL. Head reassignment requires branches:assign_head ALL and an active in-branch employee with branches:update BRANCH/ALL. Clear head with branchHeadId:null. A branch with active employees/head cannot deactivate.

Location GET endpoints support page,limit,sortOrder,search,isActive (default true). District lists require stateId; block lists require districtId. Creation bodies are `{code,name,sourceVersion?}`, plus stateId for districts or districtId/kind for blocks. kind is BLOCK or TEHSIL. PATCH only accepts revision,name?,isActive?; parent and code are immutable. Referenced records cannot deactivate. These are implemented; /reference-values is implemented in Phase 5 with settings:manage ALL writes and authenticated locations:read ALL reads.

Role create/update additionally accepts allowsNoBranch; enabling it requires sensitive delegation. Policy create/PUT derives creatorRoleRevision and targetRoleRevision on the server; clients cannot set those snapshots. POLICY_REAPPROVAL_REQUIRED/409 means a role revision changed and an administrator must review and PUT the policy. HIERARCHY_CYCLE, HIERARCHY_TOO_DEEP, ACTIVE_REPORTS, BRANCH_HEAD_IN_USE and LAST_ADMINISTRATOR are 409 guards; out-of-scope objects return generic 404, unsupported destinations/roles 403, invalid active references 400. Reporting policy edits used by active employees can return REPORTING_POLICY_IN_USE/409.

Configurable payment modes/panel brands/technologies/lead sources at /reference-values are implemented in Phase 5; see PHASE5.md.

## Phase 6 runtime details

See [PHASE6.md](PHASE6.md) for complete call, visit, photo and review examples. GET call/visit `/:id/history` provides paginated append-only changes; GET `/telecaller-reports/calls/:id` returns a scoped call. Visit photos use POST `/sales-reports/visits/:id/photos/upload-intents`, POST `/:id/photos/:fileId/confirm` and GET `/:id/photos/:fileId/download`. The upload body is the image DTO without purpose; the parent sets SITE_VISIT. Completion additionally requires clientCapturedAt. Filters use employeeId, customerId, leadId, branchId, callOutcome/visitOutcome, reviewStatus, inclusive Kolkata `from`/`to` dates, page/limit/sortOrder. Daily data is `{timezone,days}`; each day/employee row separates totalCalls/callDurationSeconds from approvedCalls/approvedDurationSeconds. Report key replay is 201; concurrent stale revision is 409. No report edit/delete or manual daily-summary endpoint exists.

## Phase 7 runtime details

See [PHASE7.md](PHASE7.md) for full contracts, examples, evidence mappings and default policies. POST/PATCH targets accept decimal strings and Kolkata date-only boundaries; response dates are UTC with businessStartDate/businessEndDate. Percentages are exact uncapped decimal strings. GET `/targets/reports` returns paginated progress rows; `/targets/summary` groups matching branch/type/period/exact-boundary goals, bounded to 500 definitions. Both return `{rows,asOf,timezone,verifiedOnly,actualIsScoped}` plus pagination metadata. Source grants are required in addition to target visibility.

GET `/target-evidence` lists historical lead milestones; POST `/target-evidence/leads/:id/capture` with `{milestone}` captures the earliest legacy event as PENDING; PATCH `/target-evidence/:id/review` with `{revision,reviewStatus,remarks}` performs independent scoped verification; GET `/target-evidence/:id/history` returns immutable decisions. The credited employee or performer cannot self-approve. New milestones are captured automatically within the lead transaction. Counts/INR values derive only from approved original evidence, with historical attribution and no reopened-lead duplication.

## Phase 8 runtime details

[PHASE8.md](PHASE8.md) documents payloads and interpretation for the nine shared dashboard GET routes, including the added `/dashboard/role-performance`. Query dates are valid Kolkata date-only boundaries spanning 1-366 days; from/to semantics use startDate/endDate here. Standard responses wrap `{kind,timezone,asOf,requestedPeriod,data}`. Filters intersect every relevant source/dashboard scope; missing source grants yield unavailable sections or 403. Role/search/manager filters require visible users; location filters refer to visible branch geography. Lead stock/cohort statuses are operational; approved reports/milestones drive performance and trends. Targets retain compatible full-period definitions.

GET/PUT `/dashboard/attendance-calendars/:id` reads/configures branch weekdays/holidays with expected revision; PUT requires settings:manage ALL. Absent counts are provisional current eligible staff without visible check-in, null when calendars are incomplete and unavailable for historical employment reconstruction. POST `/dashboard/exports` takes `{kind,query}` and queues an owner-only private metric/value CSV; GET `/dashboard/exports/:id` reads status and GET `/:id/download` reauthorizes/recomputes the same-asOf output before returning a version-bound 60-second URL. General audit browsing and notification contracts remain future features outside the implemented production-readiness checklist.
