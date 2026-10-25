# Phase 1-9 verification

Verified locally on 2026-10-17 with Windows PowerShell, Node v24.11.0 and npm 11.6.1. GUIDE.md was preserved. The user explicitly authorized Phase 9. Production-readiness implementation is documented in PHASE9.md; actual deployment acceptance remains environment-specific. The workspace is not a Git repository, so no commit or PR was created.

## Final checks

| Check | Result |
|---|---|
| npm run check:release | PASS: ESLint, strict TypeScript, 268 tests across 21 files with coverage, production build, production audit and synthetic Compose validation |
| npm run test:coverage (through check:release) | PASS: 268 tests; 89.50% statements, 81.36% branches, 93.31% functions and 95.31% lines in configured scope |
| npm audit | PASS: zero reported vulnerabilities including development dependencies at verification time |
| npm run audit:production | PASS: zero reported production dependency vulnerabilities at verification time |
| docker compose config --quiet | PASS: configuration validates |
| npm run validate:production-compose | PASS: production and isolated smoke Compose configurations validate with synthetic settings |
| npm run test:container | NOT RUN past preflight: command exits nonzero because the Docker Desktop Linux engine is unavailable |
| Read-only load tool | PASS: isolated test app readiness, 100 requests/concurrency 5, 100 HTTP 200, zero errors; not production capacity validation |
| Docker image/container execution | NOT RUN: Docker CLI is installed, but the Docker Desktop Linux engine is unavailable |

Full checks and coverage run sequentially with two Vitest workers to bound real MongoDB/Argon2 resource contention. Startup, OpenAPI and secret-redaction assertions pass.

## Phase 3 behavior verified

- Authenticated employee creation through current approved role templates; no public registration, client passwords/hashes or forged organization fields.
- Active role/manager/branch checks, company-wide-role branch rules, permitted manager relationships and source/destination scope.
- Unique normalized identifiers, encrypted invitation queueing and safe public projections excluding credentials, authVersion and bootstrap markers.
- BH subordinate creation, BDO-approved MH templates, higher-role/cross-branch denial and policy revision reapproval after role changes.
- Sensitive-template delegation, branch visibility distinct from managerial authority, peer-manager edit denial and dedicated role assignment.
- SELF/branch/subtree list and record isolation, client filter intersection, literal search, safe sorting, UTC date filters and bounded pagination.
- Flat paginated hierarchy/downline queries with authorized roots and depth limits.
- Expected-revision profile writes; concurrent edits produce one success and one conflict.
- Root placement protection and dynamic last-administrator guards, including custom administrators and pending invitations that cannot count before password setup.
- Soft deactivation/reactivation with active-report guards, immediate session revocation and invalid active/EXITED combinations.
- Successful manager changes, self/cross-branch denial and concurrent reciprocal changes that cannot commit a node cycle.
- Twenty-level hierarchy limits; moves/role changes reject incompatible active child relationships.
- Atomic branch transfers with new scope, old-branch/subtree denial, affected-session revocation and audited before/after IDs.
- Contact changes consume old recovery/setup links, expire queued deliveries and replace pending invitations; stale links cannot regain access.
- Employee/invitation rollback when required audit insertion fails.
- Branch CRUD through soft deactivation, scoped BH profile edits, dynamic head eligibility and explicit head reassignment before employee transfer/deactivation or role capability removal.
- Active state/district/block parent chains; unauthorized master writes, referenced-master deactivation and immutable-parent changes are rejected.
- Positive master lifecycle updates enforce child-first deactivation, parent-first reactivation and expected revisions.
- Vetted JSON reference seeding is validated, idempotent and conflict-safe; synthetic fixtures are confined to test databases.
- Organization index/metadata migration handles legacy rows, preserves reviewed flags and leaves modified templates stale until explicitly approved.
- OpenAPI specification covers Phase 1-9 runtime routes; validation is included in the checks above.

All Phase 1-2 regressions also pass: environment/security validation, Kolkata day boundaries, secret redaction, health/readiness and secret-safe startup, CORS/body/injection controls, real replica-set transactions, Argon2id authentication, explicit JWT checks, CSRF/cookies, refresh rotation/replay/concurrency, logout/password reset/change, encrypted delivery retries, dynamic permission revocation, protected system roles and immutable audit rollback.

## Verification boundaries

Coverage excludes the server entrypoint, MongoDB connection adapter and declarations. Operational script wrappers are typechecked/built but not executed against a deployment database; their underlying bootstrap, invitation, index, migration, seeding and delivery services are exercised with real temporary replica sets. SMTP uses injected senders in tests, so live transport is not verified.

No real MD/employee/branch account was provisioned, no application database was accessed and no email was sent. Real SMTP delivery, production DB privileges, deployed ingress/cookies, Docker execution, signal-driven production shutdown and approved geographical data require environment validation. Remote CI has not been run.

## Upgrade and deployment gates

Run npm run db:indexes:attendance with an operational database identity before Phase 4 rollout; it includes identity/organization prerequisites. Configure private S3/IAM as documented in PHASE4.md. Review legacy company-wide flags and reapprove stale creator/target policies explicitly. Create approved location masters and branches, then use authenticated employee creation and the existing credential worker for invitations. See PHASE3.md and ENVIRONMENT_SETUP.md.

Deploy Phase 8 with npm run db:indexes:dashboards before version 0.8.0 traffic, configure explicit attendance calendars and schedule npm run jobs:dashboards for private CSV exports. See PHASE8.md. General notifications, Redis integrations and production operational acceptance remain later work; their future contracts are not claimed as implemented APIs.

## Phase 4 behavior verified

- Authenticated server-timed check-in/out, Kolkata business-date boundary and checkout through midnight, one daily record and one open shift, concurrent submission conflict/rollback.
- Strict evidence DTOs, valid calendar/zone timestamps, GPS coordinate/accuracy bounds; no actor, branch or server timestamp forgery.
- Private upload owner, purpose, pending/ready/attached state and expiry; wrong/foreign/unconfirmed/expired photo rejection, once-only attachment, outstanding intent limit.
- Capture skew, missing/poor accuracy and geofence flags; branch schedule/policy validation, ALL-only policy mutation and immutable capture-policy snapshots.
- SELF, BRANCH, DIRECT_REPORTS, REPORTING_SUBTREE and ALL applied to histories and summaries, filtered pagination, parent-authorized evidence downloads and separate generic file ownership restrictions.
- Scoped revision-checked reviews, self-review denial, invalidation after checkout; effective-time corrections preserve raw evidence, require reason, reset review and append before/after audit.
- Worked-minute/late/early summary calculations use the captured schedule and effective intervals; rejected evidence contributes zero worked minutes.
- Audit failure rolls back attendance and photo attachment. Deactivated users cannot read attendance or evidence.
- AWS adapter command tests verify exact-size/checksum/encryption POST policy, bucket safety requirements, metadata/signature rejection, bounded version-pinned range reads and 60-second downloads.
- Orphan cleanup claims expired unattached files, retries failed deletion and preserves attached/fresh files; SDK checks cover exact-key versions/delete markers.
- CloudFormation YAML parses and bucket/policy structure checks pass locally; this is not AWS deployment validation.

New tests inject photo storage and mocked SDK commands. No AWS requests, bucket changes, IAM deployment, live SMTP delivery or production database operations were performed. Actual S3/IAM/CORS and browser capture require target-environment validation. Attached evidence retention is deliberately not automatically destructive; see PHASE4.md. Runtime wrappers are typechecked/built; real operational migration/cleanup scripts were not run against the user's environment.

## Phase 5 behavior verified

- Private checksum-bound CSV upload intent/ownership/state/expiry and purpose attachment; request authority, traversal/type/byte-limit rejection.
- Streaming UTF-8/BOM, quoted commas/newlines/escaped quotes; malformed encoding/quoting/NUL/inconsistent columns, 50000-row/column/cell/record/byte boundaries and stalled upstream timeout.
- Complete staged previews before live customer creation; normalized E.164 phones, active parent-qualified locations, row rejection reports and within-file/existing duplicate handling.
- Configurable BRANCH/COMPANY dedupe, policy freeze after first customer, generic cross-branch duplicate outcomes and concurrent commit duplicate skips.
- Confirmation selects an eligible caller; current source/branch/destination/recipient checks, expected revisions and purpose-bound attached file.
- Worker lease recovery, current role permission removal, inactive recipients, failed confirmed-job resumption and batch audit rollback/retry without duplicate records.
- Delegated source creator moving outside the confirmer's subtree stops work even if branch and destination remain permitted.
- Customer ASSIGNED/branch/subtree isolation, atomic bulk old/new-scope reassignments, invalid recipients, stale-revision all-or-nothing rollback and ownership handover.
- Interested-only customer conversion, required idempotency header, same-body concurrent replay, key/body conflict, source uniqueness, foreign conversion denial and transactional audit rollback.
- Exact BigInt/Decimal128 multiplication, half-up INR rounding, maximum precision/zero and rejected client-computed fields.
- Lead read/filter/pagination isolation, canonical assignee separate from historical sales attribution, same-branch eligible recipient and concurrent assignment conflict/history.
- Proposal creation/approval/rejection, stale lead revisions, ordinary proposer approval denial and retained original creator visibility.
- Controlled status edges, hold/resume, scoped terminal reopening, frozen conversion event value, terminal edit denial, append-only history and pinned workflow versions.
- Administrator-only real reference/workflow/settings configuration; idempotent index/default setup preserves existing role/custom configuration.
- Explicit default receive-capability rollout is idempotent, audits only missing additions and increments role revisions for creation-policy reapproval.
- Background exports escape formulas/quotes, pin private versions and reject revoked read grants on download. SDK tests validate CSV HEAD/version/size checks, exact version streams and encrypted checksum-bound export writes.
- All Phase 1-4 regressions and current OpenAPI validation pass. Private bucket YAML/three-prefix runtime/cleanup policy structure validates locally.

No user application database or production customer/role was modified; internal migrations/capability/job services ran only in isolated test replica sets. No AWS request or resource deployment, live SMTP, production scheduler, remote CI or real browser CSV upload was used. Real S3/IAM/CORS, job scheduling, load, backup/restore and approved source/export retention require deployment validation. See PHASE5.md for operational commands; source and attached file retention is not automatically destructive.

## Phase 6 behavior verified

- Current assigned-customer and lead access; server-owned employee/branch attribution and immutable customer snapshots; no historical salesExecutiveId authorization.
- Server-derived call duration, strict zoned/calendar timestamps, non-future/ordered/seven-day/four-hour interval limits, overlapping/duplicate-call rejection and rejected client duration.
- Durable call/visit idempotency; concurrent retries return a single report; conflicting key reuse fails and reassignment revokes replay eligibility.
- SELF/current-subtree/ALL report visibility and scope-first daily aggregation, unauthorized employee-filter intersection, inclusive Kolkata business dates and separate submitted/approved totals and literal outcome counts.
- Revision-checked review races, no self approval or OPEN-visit review, scoped append-only history, rejected history query/document-save/document-delete mutation and transactional audits.
- Separate visit submissions, map latitude/longitude and correct GeoJSON order, server timing, stale/poor-accuracy evidence flags, 24-hour expiry with preserved EXPIRED history and a new visit allowed.
- Parent-bound photo issuance/confirmation and immutable version attachment; foreign-visit/expired/unattached photos and foreign completion/download are rejected; malformed decimal/MIME/revision/follow-up inputs fail.
- Invalid multi-photo sets and audit failure roll back attachments, report, lead progression and history. Concurrent completion commits one submission/lead event.
- Current assignment, employee ACTIVE status, branch status, reporting grants and explicit receive capability are revalidated; removed lead-update rights cannot gain workflow or follow-up authority.
- Pinned workflow progression advances only a scheduled completed visit, preserves later lead stages, respects custom edges and freezes exact-decimal observation valuation/follow-up.
- Scoped version-bound private downloads exclude provider metadata; generic attendance confirmation rejects visit files; expired orphan visit versions use existing cleanup.
- New index migration services execute against a temporary replica set. OpenAPI validation includes all Phase 6 routes. Private bucket YAML validates four-prefix runtime/cleanup policy structure locally; npm audit and Compose config validate.

Phase 6 deployment requires db:indexes:reports and the updated private-photo IAM policies; see PHASE6.md. Tests use injected photo storage and existing mocked S3 adapter coverage. No live AWS/browser upload, real application database migration or production deployment was performed. Attached evidence has no automatic deletion policy.

The Phase 7 compiled-artifact smoke check passed: OpenAPI version 0.7.0 contained 10 target/evidence path templates; dist/scripts/target-indexes.js existed. Phase 6 reporting paths and migration remained available.

Reporting module coverage: 95.65% statements, 86.33% branches, 98.68% functions and 100% lines. Overall coverage includes operational wrappers; those wrappers are built but not executed against deployment services.

## Phase 7 behavior verified

- Scoped employee target assignment with server-owned branch/assigner and current capability/role/employment/branch eligibility; manager subtree versus branch destination and historical-source checks.
- Canonical DAILY, Monday WEEKLY, calendar MONTHLY and bounded CUSTOM Kolkata periods; valid date-only DTOs, half-open filters and UTC boundaries.
- Whole count versus exact monetary target values; rejection of client actual/percentage/branch/assigner fields and fractional count goals.
- Serialized duplicate/overlap create protection, adjacent periods, separate daily/monthly/custom commitments, stale concurrent update conflicts, cancellation/reactivation overlap checks and inactive employee cancellation.
- Immutable full definition revisions and audit rollback; scoped list/count/record/history access and primary-branch transfers retaining original target attribution.
- Approved original call/visit actuals, explicit connected/visit outcome rules, exclusion of pending/rejected/open/unavailable attempts and future timestamps, half-open completion boundaries, uncapped and zero-goal achievement.
- Exact BigInt/Decimal128 values above floating-point safe precision; frozen conversion value retained despite later lead edits/reassignment, and first-conversion credit preserved across reopening/reconversion.
- Pending CREATED/QUALIFIED/CONVERTED evidence captured transactionally; independent review, stale review races, verification withdrawal, append-only review history and evidence/audit rollback.
- Historical first-event/assignment-revision capture, fabricated/missing milestone rejection, missing conversion-value approval denial, and original lead creation-time attribution across business boundaries.
- Generated-lead credit visible to the telecaller and credited employee's current manager even when originally unassigned; parent lead contact read remains independently restricted.
- Progress requires target plus report source visibility and lead source grants for milestones; source permission removal applies immediately to existing sessions.
- Compatible group summaries separate target types, period types, exact bounds and branch; scoped employee totals, weighted percentages, and paginated target reports.
- Explicit index services run on temporary replica sets; runtime OpenAPI validates and compiled target migration/10 target path templates are checked.

Phase 7 uses no new external service or environment secret. Real application data was not read or migrated, and production deployment/query-plan/load validation was not performed. Deploy db:indexes:targets before version 0.7.0 traffic, review historical pending evidence through the scoped capture/verification APIs, and enforce insert/read-only DB privileges for immutable histories. See PHASE7.md for explicit verification/attribution defaults and alternatives.

Phase 7 target module coverage was 91.64% statements, 84.57% branches, 92.42% functions and 97.23% lines. Its full checks and coverage passed 226 tests across 17 files before Phase 8.

## Phase 8 behavior verified

- All six default roles and custom role grants; independent dashboard/source/export scopes, current reporting subtrees, primary branch and original creator/current assignee visibility.
- Scope-first employee, branch and current-role labels/counts; inaccessible dimensions remain empty, source-unavailable sections are explicit, and pagination follows global authorized ranking.
- Current lead stock/cohorts/follow-ups remain distinct from verified performance; approved calls/visits and immutable approved milestones drive rankings and exact financial totals.
- Decimal128/BigInt financial ordering above floating-point safe precision; approved target actuals and full target-period denominators remain consistent with Phase 7.
- Kolkata completion/month boundaries, clipped event windows, equal elapsed prior-period comparisons, strict DTOs and source-specific filters.
- Explicit branch working calendars, empty holidays, revision conflicts and audit rollback; current-day provisional absence excludes future joiners and roles without attendance submission, and intersects attendance/user scopes.
- Scoped import statistics and safe recent report projections; no customer contacts, GPS, private storage metadata or report notes in dashboard/export responses.
- Private metric/value CSV jobs with formula escaping, owner-only status, queue limits, expiry, bounded worker leases/retries, storage failure tracking and existing orphan cleanup.
- Fresh source/read/export checks before publication and download; revoked grants, narrowed scopes, withdrawn evidence and changed visible values reject stale aggregate files.
- New index services execute against isolated temporary replica sets. OpenAPI validation includes dashboard routes. Version 0.8.0 compiled smoke checks confirm 13 dashboard path templates and both dashboard migration/worker scripts.

Phase 8 adds 25 integration tests and two CSV unit tests. Full regression checks pass 253 tests across 19 files. No real application database migration, live S3 request, production worker scheduling or deployment was performed. Production query plans/load, retention, monitoring and deployment acceptance remain Phase 9. No new environment secrets are required; exports use the existing private encrypted/versioned S3 configuration. See PHASE8.md for commands and operational limits.

Dashboard module coverage: 92.80% statements, 79.90% branches, 96.46% functions and 99.68% lines. Full checks and coverage both pass 253 tests across 19 files.

## Phase 9 behavior verified

- Separate shared HTTP/auth MongoDB quotas across independent API instances; concurrent first increments, normalized/HMAC client identifiers, independent namespaces/windows and explicit reset/decrement behavior. Synthetic clock windows stay ahead of the real TTL sweeper to avoid cleanup races in tests.
- Strict authentication quotas remain independent from general quotas; store failures return safe 503 without a memory fallback, and liveness remains available.
- Production configuration rejects local-only quotas, bounds monitoring/pool settings and rejects standalone MongoDB before HTTP binding. Real replica-set tests verify production startup creates no collections implicitly.
- Additive production index creation preserves role documents and operator-managed extra indexes. Read-only inventory checks installed declarations and detects missing TTL indexes or incorrect options.
- A 1200-record direct-report fixture uses IXSCAN and examines only four matching documents; a 1200-record employee report history uses completion range bounds and returns/examines one document.
- Metrics require current settings:manage ALL, reject unknown filters, exclude credentials/contact information, and reflect permission removal in an existing session. Queue collection occurs outside administration/hierarchy fences with fresh authorization before collection and publication.
- Real HTTP socket tests drain an active response before DB disconnect, close once, prevent late bind after termination during startup, preserve nonzero fatal shutdown during a normal drain and force failure on a cleanup deadline/error.
- Automatic access logs exclude raw paths, queries, request bodies, authorization and cookies; secret-safe startup errors and prior security regressions pass.
- OpenAPI 0.9.0 validates; compiled artifacts contain /operations/metrics and both production index/preflight scripts. Existing dashboard/target/report migrations remain available.
- Dependency audits report zero vulnerabilities. Development, production and smoke Compose definitions validate. The load CLI successfully exercises 100 read-only readiness requests at concurrency five against the isolated test app (401 ms total, p50 11 ms, p95 39 ms, p99 92 ms in that local run).

Phase 9 adds 15 tests; the full check passes 268 tests across 21 files. The final check:release command runs lint/typecheck, the full suite with coverage, build, production audit and synthetic Compose validation once; CI additionally runs the complete dependency audit and isolated container smoke. The Linux CI workflow includes coverage artifacts and isolated image/migration/readiness/non-root/read-only/SIGTERM smoke automation. It has not been executed on a remote runner. Local container smoke was attempted and stopped at its Docker-engine preflight; no image/container execution is claimed. Negative load-CLI checks reject remote targets without opt-in, write paths and excessive concurrency/invalid counts before network requests, without exposing a supplied test token.

No application database, real employee/customer data, cloud provider, SMTP transport, production scheduler or deployed ingress was accessed or changed. Production TLS/auth/least privileges, query plans/load/fence contention, image scanning/SBOM, S3/browser delivery, worker schedules, backups/restore and live rollout acceptance remain target-environment gates. Redis caches, general notification/reminder APIs and generic audit browsing remain future features. See PHASE9.md for setup and operational runbooks.

Final operations module coverage: 94.57% statements, 80.76% branches, 100% functions and 98.91% lines. ServiceRuntime coverage: 93.22% statements, 81.25% branches, 100% functions and 94.28% lines. Server signal wiring and database adapter are excluded from the configured coverage scope; standalone/startup child-process tests still exercise startup behavior, while real container signal acceptance remains unavailable locally.
