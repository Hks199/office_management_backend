# Deployment and operations

Phases 1-9 provide the business APIs and production-readiness tooling. Version 0.9.0 rollout requires the additive production migration, read-only preflight, shared quotas and target-environment acceptance documented in PHASE9.md.

## Development containers

For 0.9.0, follow PHASE9.md: migrate with db:indexes:production, inspect with ops:preflight, use shared MongoDB quotas and the independent docker-compose.production.yml. npm run validate:production-compose checks synthetic configuration; npm run test:container needs a running Linux Docker engine and exercises an isolated project. The CI workflow runs checks/coverage/audit/container smoke and retains coverage artifacts. No image publication or production deployment occurs automatically. Monitoring is GET /api/v1/operations/metrics with live settings:manage ALL. A bounded test:load command supports authorized read-only staging measurements.

Populate JWT_SECRET and TOKEN_ENCRYPTION_KEY in .env before starting the API; Compose passes them into the container without insecure defaults.

```sh
docker compose config --quiet
docker compose up --build -d
docker compose logs -f api
docker compose down
```

`down` preserves volumes; avoid `down -v` unless explicitly intending to erase development data. Compose is development-only: MongoDB is unauthenticated and the API runs in development to expose opt-in docs. Optional Redis uses `--profile cache`. API and database ports bind host loopback. MongoDB replica set is initialized by healthcheck before API startup.

## Production image

Multi-stage Dockerfile builds TypeScript with `npm ci`, installs production-only dependencies in runtime, and runs as non-root `node`. Source/tests/.env are excluded from runtime. Use `docker build -t sunvika-api:<release> .` and inject secrets through the deployment environment. Set NODE_ENV=production, DOCS_ENABLED=false, authenticated TLS MONGODB_URI, HTTPS CORS_ORIGINS, and a trusted ingress configuration. Expose port 3000 only behind that ingress. Set termination grace >= SHUTDOWN_TIMEOUT_MS + ingress draining time (recommended 20 seconds for the default 10-second application deadline).

CI checks lint, typechecking, tests, build, dependency audit and image build. Deployment tooling must pin approved image digests, scan the final image, create an SBOM, and refresh security patches. No registry publishing or deployment is performed by this repository's initial workflow.

## Health and shutdown

Liveness `/api/v1/health/live`: process available. Readiness `/api/v1/health/ready`: bounded database ping succeeds and process is not draining. Configure orchestrator startup probes to allow DB connection and runtime startup, readiness every 10–30 seconds, and liveness independently. Health routes avoid general rate quotas but infrastructure should restrict excessive probe traffic. The bounded image healthcheck honors PORT, defaulting to 3000.

SIGTERM/SIGINT mark service draining, stop accepting HTTP, finish active requests and disconnect MongoDB. Deadline closes connections and exits nonzero if draining stalls. Header/request/idle timeouts are bounded. Fatal errors shut down instead of continuing in unknown state. Startup fails closed before listening on database/configuration errors.

## Production prerequisites by phase

| Area | Required operation |
|---|---|
| Database | Authenticated private replica set, TLS, least-privilege runtime role, backups and restore drill; deploy versioned indexes and validate uniqueness |
| Identity | Secret-managed JWT keys, rotation/runbook, secure invitations, approved reset provider, CSRF/cookie settings, audited MD bootstrap |
| S3 | Private bucket/encryption, IAM role, CORS, scanning/quarantine, confirmed ownership/signature workflow, approved retention |
| Quotas/jobs | Shared MongoDB HTTP/auth quotas, separate scheduled credential/commercial/dashboard/cleanup workers, backlog/retry monitoring; Redis remains optional future integration |
| Authorization | Approved default grants/role creation/cross-branch policies; live role invalidation and IDOR tests |
| Audit | Append-only application credentials, restricted readers, retention approval, transactional write guarantees |
| Ingress | TLS, strict forwarded-header trust, request/connection limits, private backend network |
| Monitoring | stdout JSON log collection with redaction, latency/error/saturation/DB pool metrics, security and worker alerts |

Production requires the MongoDB shared rate store for both general and authentication quotas; local memory is for development/tests. Automatic collection/index creation is off in production. Authorization-sensitive dashboard caching remains disabled. Future caches must preserve immediate scope/session revocation. Slow command telemetry excludes command documents, results and raw errors.

## Release and rollback

Run `npm run check`, dependency audit, database integration/security tests and container smoke checks before promotion. Store immutable build artifacts. Deploy backward-compatible indexes/schema changes before code; migrate records with resumable versioned scripts and backups. Rolling rollback restores the previous image; do not remove audit/history fields or drop indexes blindly. Verify readiness and a scoped employee workflow after rollout once business APIs exist. Rollbacks of authorization changes require explicit review to avoid restoring unwanted grants.

## Verification limits

See VERIFICATION.md for the actual local results. A Docker CLI alone does not prove image/container execution. AWS, Redis, external mail, production MongoDB and deployment credentials are not required or exercised by Phase 1. No production deployment, external provisioning or remote account mutation was performed.

## Phase 2 rollout and credential worker

Deploy identity collections/indexes explicitly with `npm run db:indexes:identity` (inside runtime image: `node dist/scripts/identity-indexes.js`). Bootstrap only once with `bootstrap:md`, then start the API to deliver its invitation automatically. Production runtime contains compiled internal scripts but not tsx; use `node dist/scripts/<script>.js`. Inject bootstrap identity and SMTP settings through restricted operational tooling; Compose API startup alone does not provision an MD.

The API automatically delivers invitations and password resets when SMTP_HOST and MAIL_FROM are configured; both Compose configurations forward SMTP credentials and worker settings. The worker starts immediately, then polls every five seconds without overlapping batches. Pending jobs persist across restarts; expired leases are reclaimed. Monitor PENDING/FAILED age, safe lastErrorCode categories and five-attempt exhaustion. Keep the API running under the existing restart policy. SMTP acceptance does not guarantee inbox placement.

For a separately scheduled worker, set CREDENTIAL_DELIVERY_ENABLED=false in the API and schedule `node dist/scripts/deliver-credentials.js` with SMTP secrets and the same credential-encryption key. That optional command drains at most 50 leased jobs. TTL removes expired delivery jobs and credential records; expiration is also checked before sending/redeeming.

Run index/bootstrap/seed scripts using an operational DB identity with schema/index privileges. The normal API identity should have only required CRUD privileges, plus insert-only access to activity_logs. Credential worker needs delivery/token/user read and delivery-update privileges, without role administration. Back up encryption keys alongside secure key management procedures; losing the delivery key makes pending ciphertext unreadable.

Live SMTP, production IAM/DB privileges and container execution have not been tested locally. Test the invitation/reset frontend flow and same-site secure-cookie behavior behind your actual ingress before business deployment. General notifications, Redis caching and remaining business modules are later-phase work.

## Phase 3 organization rollout

Run `npm run db:indexes:organization` (runtime image: `node dist/scripts/organization-indexes.js`) with index/migration privileges before employee/branch APIs are used in production. Review legacy role company-wide flags and policy snapshots after migration. Only revision-zero default MD/BDO templates gain their documented company-wide setting automatically; modified templates need administrator review. Reapprove any stale creation policies explicitly.

Populate vetted location masters, then branches and employees through authenticated APIs, or use restricted `seed:locations` with reviewed bounded JSON input. New employees receive encrypted invitations through the automatic API worker (or a separately scheduled worker when explicitly configured). Never publish a default employee password. Branch/status/manager changes require expected revision and are audited; transfers do not move historical activity or silently cascade descendants.

Runtime DB roles need required organization collection CRUD plus insert-only audit access; operational seed/index commands require separately scoped privileges. Organization writes currently serialize on one administration/hierarchy fence, favoring correctness over high write concurrency. Measure contention before considering finer-grained locks; never remove serialization without a cycle/write-skew replacement. Query/scale optimization remains Phase 9.

Live SMTP, production DB privileges, actual geography and deployed container/ingress behavior still require environment validation. No production database or external account was modified by implementation tests.

## Phase 4 attendance rollout

Run `node dist/scripts/attendance-indexes.js` (development: `npm run db:indexes:attendance`) with the migration identity before traffic. Configure AWS_REGION/S3_BUCKET together and attach the runtime IAM policy from infra/private-photos.yaml to the workload role. Deploy/review the bucket template in the target AWS environment; no resources have been provisioned by this implementation. Validate browser POST CORS, checksum rejection, HEAD/range verification and version-pinned downloads with real IAM before employee use.

Schedule `node dist/scripts/cleanup-orphan-photos.js` hourly under a separate role with only bucket metadata checks, attendance-prefix version listing and version deletion. Monitor storage errors, expired intent counts, cleanup failures and organization-fence contention. The API role needs file/attendance writes plus insert-only audit. Attached versions have no automatic retention deletion; do not enable noncurrent expiration because a referenced version can become noncurrent. Establish an approved retention/restore policy before production. PHASE4.md documents schedule, geofence and review defaults and all current integration limits.

## Phase 5 commercial rollout

Deploy indexes first with `node dist/scripts/commercial-indexes.js` using the operational identity. It preserves customized data/grants/settings and inserts missing defaults only. Review and run the separate `node dist/scripts/enable-commercial-capabilities.js` when upgrading default roles, then reapprove creation policies invalidated by changed role revisions. Do not silently approve them or bypass the runtime role service. Configure real location/reference data and the intended duplicate scope before accepting customer data. The duplicate policy freezes after first customer creation.

Schedule `node dist/scripts/process-commercial-jobs.js` at least every minute. It handles up to five import and five export attempts per invocation using durable two-minute renewable leases. Monitor queued/failed age and reconcile partially committed import counts. Stop/drain workers before migrations. Retry/resume is bounded and reauthorized; staged rows expire after 30 days, previews after seven days, and export download jobs after 24 hours. No raw file/job content goes into logs.

Use the expanded private bucket template/IAM prefixes for imports and exports; no resources have been provisioned by code changes. Test real S3 POST/checksum/version behavior, UTF-8/CSV preview flow, permission revocation, scheduled job restarts and export downloads behind the target ingress. Preserve all referenced object versions; broad noncurrent lifecycle expiration can delete pinned evidence. Uploaded CSVs and attached exports require a reviewed retention/restore policy. Failed unattached export metadata is persisted before storage writes so existing orphan cleanup can remove it after expiry plus 24 hours. Runtime requires insert-only permissions on commercial immutable histories/workflows as well as activity_logs. Performance/backup/production container validation remain Phase 9 work.

## Phase 6 deployment

Deploy `npm run db:indexes:reports` or compiled `node dist/scripts/report-indexes.js` with the same protected migration role used for prior indexes. This creates report_activities/report_history and unique/2dsphere indexes without dropping indexes or changing existing role grants. Grant the API insert/read access to report_history; never update/delete. Update private-photo runtime and separate cleanup IAM policies to include sunvika/site-visits/* before browser uploads. Existing cleanup handles visit orphans; reporting requires no additional worker. Validate actual IAM, browser POST/CORS, version checks and authorized download expiry in the deployment environment. Keep attached photos until an approved retention workflow exists. PHASE6.md documents business defaults; Phases 7-9 remain separate work.

## Phase 7 deployment

Run `npm run db:indexes:targets` or compiled `node dist/scripts/target-indexes.js` before version 0.7.0 accepts lead/target traffic. The migration initializes target/revision/evidence/review collections and verified completion indexes; existing grants and business history are preserved. Source lead writes now include pending milestone evidence and audits in their original transaction. No historical activity is automatically approved. Use the scoped capture API for original legacy milestones and review independently; absent events/frozen values require data investigation. Apply insert/read-only DB privileges to target/review histories. No scheduler or new external service is required. PHASE7.md documents bounded summary/report execution; production load/query-plan and rollout validation remain Phase 9 work.

## Phase 8 deployment

Deploy dashboard-indexes before application traffic and schedule the separate process-dashboard-jobs worker. Runtime image commands are `node dist/scripts/dashboard-indexes.js` and `node dist/scripts/process-dashboard-jobs.js`; scripts process bounded batches. Existing private bucket/IAM exports permissions cover dashboard files; cleanup retains its separate version-delete identity. Configure branch calendars explicitly, and review source plus dashboard/export grants for custom roles. Dashboard CSVs can be invalidated by scope/data/verification changes and require regeneration. Migration and calculators are locally tested against temporary replica sets; live worker scheduling/S3/IAM and load/query-plan/production rollout acceptance remain deployment work. See PHASE8.md for bounds.
