# Phase 7: target management

Phase 7 implements scoped target assignment, revisions/cancellation, verified progress, compatible-goal summaries and paginated target reports. All routes are under `/api/v1` with live bearer authentication and no-store responses. Dashboard implementation remains Phase 8.

## Setup

```sh
npm ci
npm run db:indexes:targets
npm run check
```

The migration initializes prerequisite collections plus targets, target_revisions, target_evidence and target_evidence_reviews, and indexes approved activity by employee/branch/completion time. It does not change role grants or automatically approve historical activity. Runtime image command: `node dist/scripts/target-indexes.js`. Deploy the indexes before routing traffic to version 0.7.0: lead creation/qualification/conversion now captures pending evidence in its existing transaction. The commercial setup also initializes the evidence collection used by these lead writes.

No new environment variables, provider credentials, scheduler or Redis dependency are required. Existing default target/report/lead permissions cover the new APIs; upgraded/custom roles retain their configured grants. Production DB privileges should allow insert/read only for target_revisions and target_evidence_reviews, matching other immutable histories. The API must update targets and evidence review state; application DTOs restrict those writes.

## Assignment and definition policies

Supported target types: CALLS_COMPLETED, CONNECTED_CALLS, LEADS_GENERATED, SITE_VISITS, QUALIFIED_LEADS, CONVERSIONS and SALES_VALUE. Employee and branch are authoritative server references; assignedBy is the authenticated manager. No role-name switch controls runtime access. targets:create/update scopes apply to the employee's current placement; updates also require visibility of the historical target branch/owner. MD's ALL scope reaches all branches, managers use current descendants and BH uses branch scope. Explicit SELF creation authority permits self assignment; ordinary TC/SEX defaults only grant target reads.

Targets require an ACTIVE employee with an active role and active primary branch. Calling types require customers:receive_assignment, visit/qualification/conversion/value types require leads:receive_assignment, and generated-lead targets require leads:create. This uses capabilities so custom roles work. Branchless company managers can assign targets throughout their scope but are not target recipients until they have a primary branch. Cancellation alone remains possible for an inactive employee if both source and current destination remain in scope. Employee/type/period type/branch/initial assigner cannot be changed through target PATCH; create a separate target for a different assignment.

Values are **decimal strings**, up to 16 integer and two fractional digits, nonnegative. Count goals must be whole numbers; zero is allowed. Persisted values, actuals and percentages serialize as strings. Percentages use exact integer arithmetic, round half-up to two fractional digits and are uncapped; a zero target returns `"0.00"` even with positive actuals. This avoids losing paise above JavaScript's safe integer range. SALES_VALUE is in INR, using the original conversion's server-calculated frozen estimated project value; it is not a payment, recognized-revenue or refund ledger.

Dates in create/PATCH/filter requests are valid `YYYY-MM-DD` Kolkata business dates. startDate is inclusive; endDate is exclusive. DAILY is exactly one day, WEEKLY starts Monday and spans seven days, MONTHLY spans the first day of one calendar month to the next, and CUSTOM spans 1-366 days. Storage/response startDate/endDate are UTC instants; businessStartDate/businessEndDate and timezone clarify the corresponding local boundaries. Date filters from/to select definitions intersecting that half-open interval. Actuals use the activity's completion/milestone instant and the target's historical branch, not its upload/review time or the employee's later branch.

Active intervals cannot overlap for the same employee, branch, target type and period type. Adjacent intervals are allowed. Different period types may coexist so employees can have daily and monthly goals; summaries group each period type and exact bounds separately. Rejecting every daily/monthly overlap would prevent that normal use case, so the default rejects overlap only within one period type. A transfer can create a new-branch target for the same interval; old/new branch activity is attributed separately.

Target status is ACTIVE or CANCELLED. Calendar end is derived from endDate rather than a mutable COMPLETED flag. Cancellation preserves definition/history; reactivation rechecks overlap and employee eligibility. Managers can revise values and past/future periods with the current revision and a reason; full snapshots remain immutable. A future policy may lock closed periods if the business requires stricter goal finalization. Current progress always reflects the latest definition and current evidence approvals; it is not a stored payroll settlement or a snapshot of what was known at a previous date.

## Verified activity rules

| Target type | Approved underlying evidence and timestamp |
|---|---|
| CALLS_COMPLETED | One SUBMITTED, APPROVED CALL report ID, attributed by callEndedAt; all valid outcomes, including zero-duration attempts |
| CONNECTED_CALLS | The same call reports with CONNECTED, INTERESTED, NOT_INTERESTED or CALLBACK_REQUESTED outcomes |
| SITE_VISITS | One SUBMITTED, APPROVED VISIT report ID with COMPLETED, FOLLOW_UP_REQUIRED or NOT_INTERESTED outcome, by visitCompletedAt; CUSTOMER_UNAVAILABLE and OPEN/EXPIRED attempts excluded |
| LEADS_GENERATED | One approved CREATED milestone per lead, attributed to original lead.createdBy, by original lead creation time (the NEW event identifies the source) |
| QUALIFIED_LEADS | One approved first QUALIFIED milestone per lead, attributed to the canonical assignee at that event revision, or the performer if unassigned |
| CONVERSIONS | One approved first CONVERTED milestone per lead with the same historical attribution |
| SALES_VALUE | Exact sum of the approved conversion milestones' original valueAtConversion, using the same conversion time and attribution |

These are explicit defaults. Alternatives include strict literal CONNECTED-only calling metrics or provider-verified telephony; those require a separately agreed policy. Calls/visits remain evidence reviewed by another authorized employee, not proof from a telephony/GPS provider. A completed lead workflow transition alone is not verification.

New lead creation, first qualification and first conversion capture PENDING target_evidence atomically with the source event and audit. A unique (leadId,milestone) index prevents repeated qualification, reopen/reconvert, retries or a changed assignee from earning another milestone. The **first recorded milestone** retains its original employee, branch, time and value. A rejected milestone must be reviewed again after investigation; redoing the lead workflow does not replace its attribution or create a later-period achievement. The alternative of crediting a later successful attempt would need an explicit adjustment policy.

Legacy milestones can be captured on demand through the scoped capture endpoint. The service uses the earliest original status event and the last immutable assignment revision at or before that event, never the current assignee or current lead value. It starts PENDING and is idempotent. No event means 404; missing/invalid frozen conversion value prevents approval instead of guessing money. Existing lead creation/assignment histories are assumed to have been written through the application; incomplete or externally edited histories require an operational data investigation, not a client-supplied credit override.

Approval requires reports:review plus leads:read on historical evidence scope. The credited employee and the original performer cannot approve their own milestone. Review uses the expected revision and remarks and appends target_evidence_reviews and an audit event in the same transaction. Rejecting/returning approval to PENDING removes that evidence from subsequent actuals while retaining all review history. Calls and visits use their existing Phase 6 reviews.

Progress requires targets:read intersected with reports:read. Lead-based progress additionally requires leads:read. For historical lead evidence, lead scope is evaluated against the **saved createdBy/assignedTo/branch snapshot**, and report scope against the credited employee/branch; it does not expose the lead's current contact or financial state. This lets a sales employee retain approved historical credit after reassignment while a new assignee does not inherit earlier achievements. For milestone evidence, hierarchy scopes use the credited employee's current descendants relationship, including originally unassigned generated leads; BRANCH follows the actor's current primary branch. Current parent-lead contact access retains its existing assignment rules. A missing source permission returns 403. Narrow source scopes produce authorized subtotals marked actualIsScoped:true; a zero subtotal does not assert that no hidden activity exists.

Actuals match scope, employee, historical branch, approval state and `[startDate,endDate)` before counting/summing. Future instants beyond the response asOf are excluded. No call's convertedToLead snapshot is counted as a conversion. There are no client-editable actuals, cached counters or daily summary rows to double-count. Progress/reports/summaries use a fresh authorization check and a coherent MongoDB transaction snapshot; writes and reviews share the existing organization/security fences.

## API examples

```http
POST /api/v1/targets
Authorization: Bearer <manager-access-token>
Content-Type: application/json

{
  "employeeId": "<eligible-employee-id>",
  "targetType": "CALLS_COMPLETED",
  "targetValue": "50",
  "periodType": "DAILY",
  "startDate": "2026-10-19",
  "endDate": "2026-10-20"
}
```

POST returns 201 with the target, server branchId/assignedBy, revision 0 and normalized targetValue `"50.00"`. A concurrent or overlapping definition returns 409 TARGET_OVERLAP. No idempotency key is needed: active overlap checks and transactional serialization prevent duplicate assignment.

```http
PATCH /api/v1/targets/<id>
Authorization: Bearer <manager-access-token>
Content-Type: application/json

{"revision":0,"targetValue":"60","reason":"Revised goal after capacity review"}
```

PATCH accepts targetValue, startDate, endDate and/or status. Expected revision and reason are required; stale edits return 409. GET `/targets/:id/revisions` returns the complete saved definitions, including initial assignment, changedBy, reason and revision, newest first. No target DELETE route exists.

GET `/targets/:id/progress` returns the definition plus `actualValue`, `achievementPercentage`, `asOf`, `actualIsScoped:true` and `verifiedOnly:true`. For example targetValue `"2.00"` with three approved activities gives actualValue `"3.00"`, achievementPercentage `"150.00"`.

GET `/targets`, `/targets/reports` and `/targets/summary` accept employeeId, branchId, targetType, periodType, status (default ACTIVE), from/to, page (1-10000), limit (1-100, default 20) and sortOrder. GET `/targets/:id` returns a scoped definition. Reports return `{rows,asOf,timezone,verifiedOnly,actualIsScoped}` with per-target progress and definition-page metadata. Summary returns the same envelope with compatible groups keyed by branchId, targetType, periodType and exact start/end. Each group includes targetCount, employeeCount, summed targetValue, deduplicated employee actualValue and the weighted achievement percentage. It never sums unrelated units or adds daily goals to monthly goals. Cancelled summaries describe cancelled definitions rather than an active commitment; default reports exclude them.

Summary grouping is bounded to 500 matching definitions; above that it returns 422 TARGET_SUMMARY_LIMIT before computing actuals, requiring narrower employee/branch/type/period/date filters. Group pages are deterministic; report pages are bounded to 100 definitions. This is a deliberate bounded implementation; large historical analytics/export and query-plan/load validation remain later work.

```http
POST /api/v1/target-evidence/leads/<lead-id>/capture
Authorization: Bearer <reviewer-access-token>
Content-Type: application/json

{"milestone":"CONVERTED"}
```

Use capture for pre-Phase-7 evidence. It requires current lead visibility as well as review scope on the derived historical evidence. GET `/target-evidence` supports employeeId, branchId, leadId, milestone, reviewStatus and pagination. Ordinary employees can see their authorized historical evidence; no custom-role names are assumed.

```http
PATCH /api/v1/target-evidence/<evidence-id>/review
Authorization: Bearer <independent-reviewer-access-token>
Content-Type: application/json

{"revision":0,"reviewStatus":"APPROVED","remarks":"Original milestone and source value verified"}
```

Review states: APPROVED, REJECTED, PENDING. GET `/target-evidence/:id/history` returns parent-scoped immutable review decisions, newest first. There is no client-controlled milestone timestamp, credited employee, conversion value or approval bypass.

## Verification and deployment boundary

Tests use temporary real MongoDB replica sets and synthetic accounts. They exercise assignment/scope, period boundaries, overlap/revision races, exact large-value arithmetic, approval withdrawal, frozen attribution/value, reopened lead deduplication, legacy capture, source permission removal, audit rollback and histories. OpenAPI covers runtime DTOs. Actual command/coverage results are in VERIFICATION.md. No real application database was migrated and no production deployment or external service provisioning was performed. Phase 8 dashboards and Phase 9 load/operational acceptance remain separate work.
