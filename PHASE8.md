# Phase 8: shared dashboards and private metric exports

Phase 8 implements shared dashboard APIs for MD, BDO, MH, BH, sales and calling employees, using current scoped grants rather than role-name switches. It includes operational overview, attendance/calendar data, lead funnel/cohorts/follow-ups, verified targets, employee/branch/current-role performance, monthly event trends, comparisons, recent report activities, import statistics and queued private CSV exports. Production operational acceptance remains Phase 9.

## Setup and deployment

```sh
npm ci
npm run db:indexes:dashboards
npm run jobs:dashboards
npm run check
```

The migration initializes all prerequisite collections/indexes, attendance_calendars, dashboard_exports and indexes for branch/date/status/activity/milestone aggregates. It preserves existing role grants and never guesses working calendars. Runtime image commands are `node dist/scripts/dashboard-indexes.js` and `node dist/scripts/process-dashboard-jobs.js`. Run the migration before enabling version 0.8.0 traffic. Schedule jobs:dashboards periodically; each invocation processes at most five leased attempts. Existing jobs:commercial remains separate.

No new environment secrets or dependencies are required. Interactive dashboards use MongoDB only. CSV jobs require the existing AWS_REGION/S3_BUCKET, private encrypted/versioned S3 bucket and IAM from Phases 4-6. Dashboard objects use the already-authorized `sunvika/exports/*` prefix, so the existing template covers them. Keep cleanup credentials separate from API credentials. Existing cleanup:orphan-photos handles failed dashboard export objects; attached exports remain retained under the deployment retention policy.

## Runtime endpoints

| Method/path, under /api/v1 | Behavior/source permissions beyond dashboard:read |
|---|---|
| GET /dashboard/overview | Available source sections only; missing grants return `{available:false,requiredPermissions:[...]}` rather than invented zero totals |
| GET /dashboard/attendance | attendance:read + users:read; scoped daily records/approval/late/early/worked minutes and provisional current-day absence |
| GET /dashboard/leads | leads:read; visible current stock, status funnel, created-period cohorts and overdue/upcoming follow-ups |
| GET /dashboard/lead-funnel | Same source calculator and definitions as leads |
| GET /dashboard/targets | targets:read + reports:read; lead-based actuals additionally require leads:read; approved Phase 7 target values and uncapped percentages |
| GET /dashboard/employee-performance | users:read + reports:read; scoped employee metadata and approved rankings, with source-available queue/attendance/target counts |
| GET /dashboard/branch-performance | branches:read + reports:read; branch rows contain authorized subtotals, not implied company-wide branch totals |
| GET /dashboard/role-performance | users:read + reports:read; current roles of visible employees, with scope applied before grouping |
| GET /dashboard/trends | reports:read; sparse monthly approved event buckets; lead milestone/money metrics available only with leads:read |
| GET/PUT /dashboard/attendance-calendars/:branchId | Visible branch calendar; PUT additionally requires settings:manage ALL |
| POST /dashboard/exports | dashboard:export + dashboard:read; queues a selected dashboard kind and validated query |
| GET /dashboard/exports/:id | Own unexpired job status; private query/principal/fingerprint/lease metadata excluded |
| GET /dashboard/exports/:id/download | Recomputes the same-asOf export under current source/read/export scopes; then signs the verified immutable object version |

Every route uses live bearer authentication, strict Joi validation and no-store responses. Public development docs/health remain independent of dashboard authentication. No result caching or role-name routing is used.

## Scope and source rules

Every source query intersects dashboard:read with its existing source permission before matching/counting/grouping. Exports additionally intersect dashboard:export. Granting a broad source permission does not widen a SELF dashboard; granting dashboard ALL does not widen a SELF source. Missing source authority on a dedicated endpoint returns 403. Overview modules without their required grants are explicitly unavailable. Available but narrower scopes return authorized subtotals marked actualIsScoped:true; a displayed zero does not assert absence of hidden activity.

SELF employee/report/attendance/target scopes use the actor's employee ID. For calling/customer/lead work, dashboard SELF includes original creator or current canonical assignee, intersected with the existing commercial source scope. This lets sales employees see assigned leads and callers retain authorized originated work. Current reporting descendants drive BDO/MH data; BRANCH drives BH data using saved resource branch IDs. SELF branch labels mean the actor's primary branch. Current branch/subtree access does not grant other branch contacts or employee identities.

Verified lead milestones retain the Phase 7 historical employee/createdBy/assignedTo/branch attribution. Their report scope and lead snapshot scope both apply; original unassigned generation credit follows the credited employee's current hierarchy. Parent lead contact access keeps its existing commercial assignment rules. Reassignment/reopening cannot re-credit a conversion. Role breakdowns deliberately use each visible employee's **current** role; no historical role snapshot is invented. Role labels are fetched only for already-visible employee IDs. Branch/employee labels and queue/target/attendance counts are independently scoped.

Imports use the established import-read creator/hierarchy/branch rules, including an authorized creator's retained own-job visibility. Only job/status/accepted operational counts appear; no staged contact rows or upload metadata are exposed. Recent activities show at most ten report IDs, owner/branch, kind/status/outcome and timestamps, excluding customer names/mobile/address, GPS, photographs, storage keys and notes.

Read calculations use a coherent MongoDB transaction snapshot and fresh authorization through the existing security/organization fences. This serializes publication/permission changes consistently with prior phases. The aggregates use server-generated `$match` predicates before `$group`; user filters never replace authorization or become raw MongoDB operators.

## Dates, filters and comparisons

```http
GET /api/v1/dashboard/overview?startDate=2026-10-01&endDate=2026-11-01
GET /api/v1/dashboard/employee-performance?branchId=<id>&sortBy=salesValue&limit=20
GET /api/v1/dashboard/lead-funnel?leadStatus=INTERESTED&leadStatus=CONVERTED&leadSource=WEB
```

startDate/endDate are valid Kolkata `YYYY-MM-DD` business dates; start is inclusive and end exclusive. Defaults are current month start and tomorrow. Requests span 1-366 days. Event windows are clipped to asOf (millisecond-inclusive asOf is represented by an exclusive next-millisecond bound), excluding future events. Source completion time drives calls/visits; original milestone time drives generated/qualified/converted evidence, matching Phase 7. Daily calling reports in Phase 6 still bucket by call start; these completion-based performance metrics are explicitly different.

Responses use `{success,message,data:{kind,timezone:"Asia/Kolkata",asOf,requestedPeriod,data:{...metrics,period:{start,end},actualIsScoped:true}}}`. period contains the actual UTC event window. Requested future windows have empty event ranges; current operational stock is still current stock, not a forecast.

For trends, compare=true (default) returns the immediately preceding **equal elapsed duration** ending at the current interval's start, with identical source scopes and filters. A partial current month therefore is not compared with an entire completed month. Comparison boundaries are explicit UTC instants and may start partway through a business day. compare=false omits that comparison. Month labels use Asia/Kolkata; trend rows are sparse and only represent approved underlying events, not reconstructed historical lead states.

Common filters: branchId, employeeId, managerId, roleId, search, stateId, districtId, blockId, leadStatus, leadSource and targetType. managerId selects employees whose immediate reporting manager matches. roleId/search/manager filters resolve only already-visible employee IDs and require users:read. Search is an escaped literal employee name/code prefix. Location filters refer to **authorized branch geography**, not a lead's customer site; use the existing lead endpoints for site-location filtering. Employee dimensions also constrain branch labels/distribution; inaccessible selections return empty visible results.

leadStatus accepts one or repeated query values and is a multi-status filter for lead stock/cohorts/queues; leadSource applies to those lead data. targetType applies to target groups. Other sources retain their own metric definitions rather than treating a lead status as an attendance/call status. page/limit apply after global authorized ranking/grouping, with limit 1-100 and page 1-10000. Rankings support approvedCalls, approvedVisits, approvedConversions, salesValue and name; order defaults descending. The default approvedConversions ranking falls back to approvedCalls when financial/lead-event data is unavailable and reports effectiveSortBy. Explicit salesValue ranking without leads:read returns 403.

## Metrics and data interpretation

- Overview employee/branch/customer/lead totals are authorized **current stock**, independent of creation dates. Active employees means current isActive/ACTIVE status, not a historical employment reconstruction. New customer/lead counts refer to the requested creation cohort. Lead funnel rows are current statuses of currently visible leads; createdCohortCurrentStatuses are current statuses of leads created in the requested window. cohortConversionPercentage uses that same cohort denominator, never all-time conversions divided by newly created leads. These status counts are explicitly marked cohortIsVerifiedPerformance:false.
- Follow-ups count nonterminal visible leads with nextFollowUpAt, split into overdue/upcoming relative to asOf. They are operational current-queue data. Imports similarly show current statuses/row counters of jobs created in the selected window, not historical job-state reconstruction.
- Activity metrics name submittedCalls/submittedVisits separately from approvedCalls/approvedVisits and pending/rejected reports. Connected outcomes and valid completed-visit outcomes match Phase 7. Rankings and monetary performance use approved original report/milestone IDs only. Current CONVERTED lead status alone never becomes verified sales performance.
- SALES_VALUE is the original server-calculated frozen estimated value of first approved conversion milestones, in INR. Sums, sorting, weighted target ratios and percentages use Decimal128/BigInt, not floating-point monetary values. Counts are numbers; amounts/percentages are decimal strings. No payment/revenue/refund accounting is inferred.
- Performance rows include source-available employeeCount, currentAssignedCustomers, currentAssignedLeads, approvedAttendanceRecords and activeTargetCount. Unavailable metrics are null, not zero. employeeCount includes currently visible employee records; role labels are current. Queue counts are current stock, while attendance/activity/conversion counts are period-based. Use the targets endpoint with employeeId for exact per-employee target goals/progress.
- Target groups reuse Phase 7 actual calculations and keep branch, type, period type and exact target interval separate. The dashboard window selects **intersecting targets**; each group's numerator and denominator remain the full target interval clipped by asOf, rather than dividing a partial-month numerator by a full-month denominator. Actual-period metadata states this explicitly. Percentages may exceed 100%; zero denominators return `"0.00"`.

## Attendance calendars and provisional absence

There is no assumed Monday-Friday/Saturday calendar. Without configuration, absence is unavailable/null. A manager with settings:manage ALL can configure each visible branch:

```http
PUT /api/v1/dashboard/attendance-calendars/<branch-id>
Authorization: Bearer <administrator-access-token>
Content-Type: application/json

{"revision":0,"workingWeekdays":[1,2,3,4,5,6],"holidays":["2026-10-20"]}
```

Monday=1 through Sunday=7. Empty holidays is valid. A missing calendar expects revision 0 and the first save returns revision 1; later PUT requires the current revision. Holidays are explicit business dates, bounded to 366 entries. Writes/audits commit atomically and stale revisions fail 409.

The eligible universe intersects users:read, attendance:read and dashboard scope. Only current ACTIVE, active, already-joined branched employees whose active role actually grants attendance:create SELF are eligible. Branchless company employees and roles without attendance submission are not assumed to owe branch attendance. Configured working weekdays and holidays then determine expected employees. Any visible raw check-in, including pending/rejected evidence, prevents a person from being mislabeled as having no record; record approvals/pending/rejections are reported separately. Distinct employee IDs prevent duplicate subtraction.

absentEmployees means **provisional eligible employees without a visible check-in**, not verified absence, lateness, a closed-day declaration or payroll. Before/through a workday the count may change. If any eligible staff lack a calendar, the complete count is null with unconfiguredEmployees. Narrow source scopes remain authorized subtotals. Historical requests outside the asOf business day return HISTORICAL_EMPLOYMENT_CALENDAR_UNAVAILABLE instead of inventing past eligibility from current staff/calendar settings. Full historical absence/leave/roster decisions need a separate effective-dated employment/calendar policy.

Attendance day rows show records and approval state, with approved late/early counts and approved completed-shift worked minutes. Raw/effective timestamps and corrections retain Phase 4 semantics; no absence or payroll conclusion is inferred from a rejected photograph.

## Private exports and reauthorization

```http
POST /api/v1/dashboard/exports
Authorization: Bearer <export-authorized-access-token>
Content-Type: application/json

{"kind":"employee-performance","query":{"startDate":"2026-10-01","endDate":"2026-11-01","sortBy":"salesValue"}}
```

kind is one of overview, attendance, leads, targets, employee-performance, branch-performance, role-performance, lead-funnel or trends. The response is 202 with job ID/status/expiry. Only dashboard:export holders can queue/read/download their jobs. Missing source grants can cause a job to fail just as they cause the corresponding dedicated dashboard endpoint to fail; overview preserves its explicit unavailable sections.

The worker uses fresh owner/session/grants, intersects export/read/source scopes, generates all bounded performance/target rows (not just the interactive page), and writes a stable UTF-8 `metric,value` CSV. Paths such as `data.rows.0.employeeCode` identify nested metrics; exact decimal values remain text. Every value is quoted, and spreadsheet formulas are neutralized with the existing CSV helper. This format exports complex/partial dashboard sections consistently rather than guessing unrelated tabular columns.

Jobs expire after 24 hours, with five outstanding jobs per owner, a two-minute lease, at most three attempts and bounded batches of five attempts per CLI run. Expired/crashed exhausted jobs fail rather than loop indefinitely. Storage failures retry; authorization, scope, stale-data and limit failures stop. File cleanup metadata is persisted **before** S3 writes. Failed writes or failed publication leave tracked unattached files for the existing version-aware cleanup. Publication attaches only the encrypted, checksum-bound immutable S3 version, and appends an audit event.

Before publication and every download, the service recalculates the **same-asOf** dashboard using current read/export/source permissions and compares a canonical CSV fingerprint. A narrower branch/subtree/source grant, changed ownership/visible metadata, withdrawn verification or changed exported values prevents an old aggregate file from remaining an authorized capability. Responses fail with 403 or 409 DASHBOARD_EXPORT_STALE, requiring a new export. This deliberately conservative policy can reject exports after relevant source updates even when the user still has access; it avoids retaining stale or newly unauthorized aggregate data. New records after asOf do not enter current-stock snapshots; edits to existing records can invalidate them.

Successful downloads return a 60-second attachment URL pinned to the verified version. It remains a bearer capability until expiry, as with prior exports. API responses exclude S3 keys/bucket/checksum/version, persisted principal/query/fingerprint and leases. Attached expired exports are inaccessible through the API but are not automatically deleted; retention still needs a deployment-approved policy.

## Bounds and verification

Interactive performance ranks at most 1000 visible employees or 250 visible branches; target summaries include at most 500 definitions. Employee/geography dimension lookups are bounded to 1000 results. Over-limit requests return 422 and require narrower filters, without silently truncating totals/rankings. Periods span at most 366 days. Individual aggregates have a ten-second DB execution bound. CSVs allow at most 50000 scalar metric rows/10 MiB. No unrestricted result caches, background provider credentials or unbounded contact exports are introduced.

Tests use isolated real MongoDB replica sets and injected storage. They verify all six default role scopes/custom roles, independent source/dashboard/export intersections, scoped labels/counts/filters/rankings, exact money, monthly boundaries/comparisons, approved-versus-operational semantics, calendar eligibility/revisions/audit rollback, target consistency, job limits/leases/retries and stale/revoked downloads/publication. See VERIFICATION.md for actual commands, counts and coverage. No production database migration, live S3/browser upload or scheduler deployment was performed. Load/query-plan validation, shared rate limits, operational monitoring and deployment acceptance remain Phase 9.
