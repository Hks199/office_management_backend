# Sunvika Office Management Backend

TypeScript/Express/Mongoose REST API for Sunvika. **Phases 1-9 are implemented:** foundation, identity/RBAC, organization, attendance, private files, customers/imports/leads, scoped reporting, verified targets, dashboards and production-readiness tooling. Live deployment acceptance remains environment-specific; see [PHASE9.md](PHASE9.md) and [VERIFICATION.md](VERIFICATION.md).

## Setup

For version 0.9.0 production upgrades run `npm run db:indexes:production` and `npm run ops:preflight`, set `RATE_LIMIT_STORE=mongo`, and follow [PHASE9.md](PHASE9.md). It includes monitoring, hardened containers, CI smoke and read-only load commands. Credential delivery now runs automatically with the API; keep commercial/dashboard/cleanup schedules active.

Requires Node 24 LTS, npm and a MongoDB replica set. Authentication writes and audit events use transactions; standalone MongoDB is insufficient.

```powershell
npm ci
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Save the first generated value as JWT_SECRET and the second as TOKEN_ENCRYPTION_KEY in your local .env. Keep the keys independent and secret. Configure MongoDB, your exact frontend origin, bootstrap identity and SMTP delivery settings as described in [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md).

```sh
docker compose up -d mongo
npm run db:indexes:identity
npm run bootstrap:md
npm run db:indexes:organization
npm run db:indexes:attendance
npm run dev
```

Bootstrap creates exactly one initial MD with no password and queues an encrypted single-use invitation. The delivery worker requires configured SMTP and sends a setup link to the bootstrap email. The frontend must implement `/accept-invitation` and `/reset-password`, reading the token from the URL fragment and posting it in JSON to the documented API. No frontend is included in this backend repository. Never put reset tokens into query strings or logs. There is no public registration endpoint.

For Docker API development, populate .env first and run `docker compose up --build -d`. To run operational commands inside the image, use compiled scripts, e.g. `node dist/scripts/bootstrap-md.js`, injecting the relevant environment through your deployment tooling. Docker Compose is development-only; production needs authenticated private MongoDB/TLS and secure secret injection.

## Commands and endpoints

```sh
npm run check
npm run test:coverage
npm run audit:production
npm run build
npm start
```

Health: `/api/v1/health/live` and `/api/v1/health/ready`. Development Swagger: `/api/v1/docs/`; OpenAPI JSON: `/api/v1/openapi.json` with DOCS_ENABLED=true. Production public docs are disabled.

Authentication: login, refresh, logout, logout-all, change-password, forgot-password, reset-password, accept-invitation, csrf and me under `/api/v1/auth`. Access tokens are short-lived bearer JWTs. Refresh tokens are HttpOnly/SameSite=Strict cookies, Secure in production. Cookie mutations need an exact allowed Origin and session-bound X-CSRF-Token. Read `/auth/me` after login for a safe profile and current grants. Use a same-site frontend/API deployment and keep access tokens in memory.

Administration: GET permissions; list/create/read/update/archive roles; list/create/update role-creation policies. Grants are controlled backend permission IDs plus scopes. Role changes affect existing access tokens on their next request; system administrator core permissions cannot be removed. Role archive uses DELETE with `{revision}` JSON and preserves the historical record. See [API_DOCUMENTATION.md](API_DOCUMENTATION.md) for authorization and examples.

Invitations and password resets are delivered automatically while the API runs, starting immediately and polling every five seconds when SMTP is configured. No manual delivery command is needed after creating an employee. Failed sends retry after one minute, up to five attempts. Missing SMTP produces a startup warning. Docker Compose forwards the SMTP settings from your private environment.

See [INVITATION_DELIVERY.md](INVITATION_DELIVERY.md) for configuration, retry recovery and verification of the automatic worker.

Operational commands: `seed:permissions` synchronizes controlled registry definitions; `seed:roles` adds missing system roles/policies after bootstrap without overwriting existing grants; `db:indexes:identity` explicitly deploys identity indexes; `deliver:credentials` optionally drains up to 50 leased SMTP jobs. `invite:reissue` queues a replacement invitation for an active employee without credentials (INVITATION_EMPLOYEE_CODE required). Set `CREDENTIAL_DELIVERY_ENABLED=false` only when using an externally scheduled worker. Keys are never printed by these commands.

## Documentation

| File | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Module boundaries and all 15 architectural decisions |
| [DATABASE_DESIGN.md](DATABASE_DESIGN.md) | Implemented identity/organization/attendance/files and future models |
| [RBAC_DESIGN.md](RBAC_DESIGN.md) | Scoped grants, seed matrix, delegation and hierarchy rules |
| [API_DOCUMENTATION.md](API_DOCUMENTATION.md) | Implemented APIs and clearly marked future contracts |
| [SECURITY.md](SECURITY.md) | Controls, threat boundaries, private S3 and retention limits |
| [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md) | Variables, MongoDB, bootstrap, SMTP, AWS and Redis |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Container operations and production prerequisites |
| [DEVELOPMENT_ROADMAP.md](DEVELOPMENT_ROADMAP.md) | Phases and acceptance gates |
| [VERIFICATION.md](VERIFICATION.md) | Actual checks and external-service limits |
| [PHASE9.md](PHASE9.md) | Shared protection, monitoring, migration/preflight, containers, load, release and recovery |

Tests use isolated temporary MongoDB replica sets and injected delivery senders; they never touch your application data or send live email. Initial test execution may download a MongoDB binary. Docker requires a running engine. No production deployment or live SMTP/S3/Redis provisioning is performed.

## Phase 3 employees and organization

Employee creation uses POST /api/v1/employees with roleId, primary branchId (explicit null only for approved company-wide roles), reportingManagerId and normalized profile fields. It queues an encrypted invitation; no password/hash is accepted or returned. List/read/profile update, soft deactivation/reactivation, dedicated manager/branch/role changes and paginated hierarchy/downlines are implemented. Transfers preserve history, record before/after attribution, and revoke the affected employee's sessions. Contact changes invalidate outstanding recovery links and replace pending invitations when needed.

Branch APIs provide scoped list/read/create/profile update/soft deactivation and capability-based head assignment. Location APIs provide state/district/block lists and admin create/name/status updates with validated parent references. Roles/policies, branch heads and employee graph edits share transaction serialization. Node cycles, cross-branch edges, incompatible active reports and last-administrator removal are rejected.

Run `npm run db:indexes:organization` when upgrading Phase 2 data. No locations are fabricated: create approved master data through the admin APIs or set LOCATION_SEED_FILE and run `npm run seed:locations` with a vetted UTF-8 JSON file. See [PHASE3.md](PHASE3.md) for contracts, policy defaults, migration behavior and examples.

## Phase 4 attendance and private photos

See [PHASE4.md](PHASE4.md) for the complete upload/check-in/review workflow and defaults. Configure AWS_REGION and S3_BUCKET together with a private, encrypted, versioned S3 bucket and workload IAM role; use the reviewable [bucket template](infra/private-photos.yaml). Run `npm run db:indexes:attendance` before rollout and schedule `npm run cleanup:orphan-photos` with separate cleanup credentials. Photo storage is optional for unrelated APIs, but required for attendance submissions. Live S3/IAM/CORS validation remains a deployment step. Phase 5 is documented in PHASE5.md.

## Phase 5 customers, CSV and leads

See [PHASE5.md](PHASE5.md) for the complete upgrade/workflow. Run `npm run db:indexes:commercial`, review the separate `npm run enable:commercial-capabilities` default-role upgrade for existing installations, reapprove affected creation policies, and configure real reference values. Schedule `npm run jobs:commercial` to process durable imports/exports. CSVs upload directly to private S3; previews stage rows before confirmation and live customers are committed in bounded audited batches. Calling/sales recipients require explicit receive-assignment capabilities. Lead conversion is idempotent; lead values use exact decimal strings; assignments/workflows have immutable history. Live AWS/IAM/CORS and scheduler validation remain deployment steps. Phase 6 reporting is documented in [PHASE6.md](PHASE6.md).

## Phase 6 activity reporting

Run `npm run db:indexes:reports` (runtime image: `node dist/scripts/report-indexes.js`). Calls and daily summaries live under `/api/v1/telecaller-reports`; separate visits, private photo uploads and review/history live under `/api/v1/sales-reports`. Reports require current assignments for submission and use scope-aware reads/reviews. Submitted and approved totals remain separate. Update the S3 template permissions for `sunvika/site-visits/*`. See [PHASE6.md](PHASE6.md) for API examples, policies and deployment limits.

## Phase 7 verified targets

Run `npm run db:indexes:targets` before deploying version 0.7.0 (`node dist/scripts/target-indexes.js` inside the runtime image). `/api/v1/targets` supports scoped assignment, revisions, verified progress, summaries and reports. Lead creation/qualification/conversion capture pending milestone evidence; managers review it under `/api/v1/target-evidence`. Exact decimal percentages may exceed 100%. See [PHASE7.md](PHASE7.md) for periods, historical attribution, verification and upgrade examples.

## Phase 8 shared dashboards

Run `npm run db:indexes:dashboards` before version 0.8.0 traffic and schedule `npm run jobs:dashboards` for private metric exports. Shared `/api/v1/dashboard` endpoints expose source-scoped overview, attendance, leads, verified targets, employee/branch/role performance, funnel and trends. Configure branch working calendars explicitly before interpreting provisional missing-check-in totals. Missing source grants are unavailable sections, not zero totals. See [PHASE8.md](PHASE8.md) for APIs, limits, comparisons, calendar and export examples.
