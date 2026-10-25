# Development roadmap and acceptance gates

GUIDE.md requires design and phased implementation. The user subsequently authorized Phases 2-9; implementation and local verification are documented per phase. Deployment-specific policies and live environment acceptance remain explicit release gates.

| Phase | Deliverables | Acceptance criteria / meaningful tests | Status |
|---|---|---|---|
| 1 Foundation | Strict TS/ESM, Express, environment, MongoDB, logging, typed errors/response helpers, Joi, headers/CORS/limits, tests, OpenAPI, Docker | Lint/typecheck/build pass; health dependency failure, input injection, CORS, malformed/oversized payloads, redaction, validation, rate limits, valid OpenAPI, real replica-set connectivity/transaction | Implemented; actual checks in VERIFICATION.md |
| 2 Authentication/RBAC | User/role/permission/session/token schemas, controlled registry, seed roles, bootstrap MD, invitations, login/refresh/logout/reset, centralized scopes, audit events | Rotation/replay/concurrent refresh, expiration, inactive users, permission removal mid-session, scoped IDOR, sensitive grants, generic recovery, CSRF and brute-force tests | Implemented; actual checks in VERIFICATION.md |
| 3 Employees/hierarchy/branches | Authorized employee management, dynamic creation policies, manager/branch transfers, bounded graph service, branches and location masters | No self/circular/concurrent cycles, authorized manager/role creation, branch vs subtree isolation, last-admin protection, location chain validation, audit and history retention | Implemented; checks in VERIFICATION.md |
| 4 Attendance/files | Private S3 intents/confirmation/download, evidence and GPS, check-in/out, reviews/corrections, calendar/summary/filtering | Unique daily check-in, concurrent check-out, Kolkata midnight, invalid GPS/time/accuracy, geofence flags, foreign/pending/wrong-purpose uploads, signature/size mismatch, denied downloads, cleanup retry safety | Implemented; local checks in VERIFICATION.md; live AWS deployment pending |
| 5 Customers/imports/leads | Streaming staged CSV validation/preview/confirmation, duplicate report, customer assignment, idempotent conversion, workflow, lead assignment/status history | Bounded memory/cell/row limits, malformed CSV/phone/location, duplicate races, cross-branch no leaks, export formula injection, replay conversion, concurrent assignment 409, invalid transitions | Implemented; local verification in VERIFICATION.md; live storage/scheduler validation pending |
| 6 Reports | Individual call activities/daily summaries, site visit start/completion/evidence, immutable report review/history | Customer/lead access, duration validation, verified vs unverified totals, idempotent activity, forbidden cross-employee reads/writes, multiple visits preserved, correct GeoJSON coordinate order | Implemented; local checks in VERIFICATION.md; live AWS validation pending |
| 7 Targets | Typed period targets, scoped assignment, revisions, verified actuals, uncapped progress and summaries | Half-open period boundaries, no duplicate activity or conversion counts, >100% achievement, zero target, decimal sales accuracy, unauthorized assignment, transfer attribution | Implemented; checks in VERIFICATION.md; deployment/load validation pending |
| 8 Dashboards | Shared scope-aware endpoints; company/subtree/branch/self views, trends/funnel, employee/branch/role performance, async CSV exports | Every aggregate/export scope equals source access; restricted lookups; no cache leaks; date comparison/timezone correctness; authorized absent counts and verified activity | Implemented; local checks in VERIFICATION.md; deployment/load validation pending |
| 9 Production readiness | Shared quotas, production indexes/preflight, runtime/queue telemetry, range indexes/query plans, lifecycle/security tests, hardened containers, CI smoke/load tools and runbooks | Local checks in VERIFICATION.md; live container/provider/ingress/load/restore/image acceptance recorded separately | Implemented tooling; target-environment acceptance pending |
| Future solar/AMC | Versioned quotations, surveys, installation, contracts/renewals, service visits | Separate business discovery and financial/contract controls | Schema boundaries documented only |

## Folder and coding conventions

Each future module has `<feature>.model.ts`, `.interface.ts`, `.validator.ts`, `.controller.ts`, `.service.ts`, `.repository.ts`, `.routes.ts`, `.types.ts` as needed; avoid redundant empty abstractions. Controllers are HTTP-only; services perform transactional business rules and call centralized authorization; repositories require explicit scope filters. No `any`, JavaScript backend files, hardcoded secrets, raw frontend Mongo filters or public registration. Narrow DTO projections exclude hashes/tokens. Add real implementations with relevant tests in each phase.

Reserved folders match GUIDE.md: auth, users, roles, permissions, hierarchy, branches, attendance, customers, leads, lead-assignments, telecaller-reports, sales-reports, targets, dashboards, csv-imports, files, locations, activity-logs, notifications, solar-projects; config, constants, middleware, shared/errors/types/interfaces/repositories/services/utils, jobs, scripts, docs; tests/unit/integration/security and docker. Scripts `bootstrap-md`, `seed-permissions`, `seed-roles` and `seed-locations` are implemented only when their models/data exist, not as no-op stubs.

## Required policy decisions

Before Phase 2: approve role/delegation matrix, cross-branch management, administrator protection, session lifetimes, invitation/reset delivery. Before Phase 3: role-manager compatibility, transfer/history visibility, location data source. Before Phase 4: schedules, overnight shifts, evidence verification, geofences and retention. Before Phase 5: dedupe identity, import limits, lead assignment/reopening/default references. Before Phase 6–7: activity verification, period overlap and target attribution. Before Phase 9: provider credentials, deployment topology, backups, telemetry and compliance retention.

Phases 2 through 9 are implemented after explicit user approval. Phase 9 tooling does not certify a production deployment; see PHASE9.md. Phase 4 uses configurable schedules/geofences, a 24-hour open-record boundary and no automatic attached-evidence retention deletion; see PHASE4.md.

## Phase 9 delivered

Phase 9 delivered shared HTTP/auth quotas, protected process/queue telemetry, bounded MongoDB pool waits and secret-safe slow-command logs, production topology/auto-create guards, additive index inventory/preflight, range indexes/query-plan tests, HTTP lifecycle regression tests, hardened production Compose, custom-port container/SIGTERM CI smoke, read-only load tooling and release/monitor/restore/rollback runbooks. Actual local checks and environment gates are in VERIFICATION.md and PHASE9.md. General notifications, Redis caches and solar/AMC remain future features.

## Phase 2 delivered

Typed user/role/permission/policy/session/credential models, controlled permission registry and default system grants, one-time invitation-based MD bootstrap, explicit index/seed scripts, Argon2id credentials, short-lived JWTs, hashed rotating refresh sessions/replay revocation, CSRF/cookies, generic queued reset delivery, session revocation, live dynamic role checks, centralized scope predicates/middleware, transactional immutable audit events, role/policy CRUD with delegation/system-role protections, bounded SMTP delivery worker, documented OpenAPI and real replica-set security/race tests. Phase 3 subsequently adds the organization routes documented below.

## Phase 3 delivered

Scoped employee read/create/profile update/status and dedicated manager/branch/role changes, encrypted invitations, approved revision-bound creation templates, branchless-role configuration, root/cycle/depth guards, active-child/branch-head protections, dynamic last-admin checks, session/credential invalidation, atomic audits, hierarchy/downline pagination, branch CRUD through soft deactivation, capability-based head reassignment, state/district/block CRUD and active parent validation, vetted bounded master-data seed command, index/metadata migration, OpenAPI, and real replica-set integration/security/race tests.

## Phase 4 delivered

Attendance state transitions, private S3 POST/confirmation/version-bound downloads, GPS/time/geofence evidence flags, configurable branch policy snapshots, scoped monthly history and daily summaries, revision-checked reviews/effective-time corrections, immutable transactional audits, orphan cleanup, explicit index migration and private-bucket/IAM template. See PHASE4.md for defaults and live integration boundaries.

## Phase 5 delivered

Customer calling queues, capability-based bulk assignment, explicit interest and idempotent conversion; exact-decimal leads with scoped read/update/filtering; current assignment and immutable history, proposals/approval and pinned versioned status workflows; configurable references and frozen-before-data duplicate policy; private checksum-bound CSV intents and full background streaming preview/confirmation; durable leased batch commit/retry/resume with fresh actor/source/branch/destination checks; scoped bounded private exports and download reauthorization; explicit index and default-capability rollout commands; OpenAPI, operational instructions and real replica-set tests. Phase 6 reporting is documented in PHASE6.md. See PHASE5.md for default policies, storage/retention boundaries and deployment validation.

## Phase 6 delivered

Employee-attributed call activities with server-derived durations, interval validation, overlap protection and durable idempotency; scoped Kolkata daily summaries with distinct approved totals; separate visit starts/completion and raw GPS evidence; parent-bound private versioned photo upload/confirmation/attachment/download; exact observation value snapshots; workflow-checked atomic lead progression/follow-ups; scoped revision reviews and append-only report history; explicit indexes, OpenAPI, IAM updates and real replica-set tests. See PHASE6.md and VERIFICATION.md. Phase 7 is implemented; see PHASE7.md.

## Phase 7 delivered

Typed scoped target assignment, canonical Kolkata periods, same-period overlap protection, current destination/historical branch checks, active capability-based recipients, cancellation/reactivation, immutable definition revisions, exact uncapped achievement, approved report actuals, first-event lead evidence with independent reviews and legacy capture, frozen historical assignment/value, scope-first bounded compatible-goal summaries and paginated reports, explicit migration and OpenAPI. Actual local checks are in VERIFICATION.md; policy details in PHASE7.md. Phase 8 dashboards are implemented; see PHASE8.md.

## Phase 8 delivered

Shared source/dashboard-scoped overview, attendance/calendars, lead stock/cohort/funnel/follow-ups, Phase 7 verified targets, employee/branch/current-role performance, import stats, recent report metadata, approved monthly event trends and equal-elapsed comparisons. Exact financial ordering, scope-first grouping/ranking/pagination, explicit unavailable sections, provisional eligible missing-check-in policy, private leased/retried same-asOf reauthorized CSV exports, worker/migrations/OpenAPI and real replica-set tests are implemented. See PHASE8.md and VERIFICATION.md. Phase 9 operational acceptance remains planned.
