# Phase 9: production readiness

Version 0.9.0 adds shared request protection, protected operational telemetry, production index/preflight commands, dashboard range indexes, a tested HTTP lifecycle, a hardened deployment configuration, container smoke automation and a bounded read-only load tool. The application and deployment tooling are implemented. Actual environment acceptance is a separate release gate: this workspace has no running Docker engine, production database, AWS/SMTP credentials, ingress or scheduler.

## Configuration and upgrade

```sh
npm ci
npm run check:release
npm audit
```

Production requires `RATE_LIMIT_STORE=mongo`; the default `memory` is accepted only outside production by environment validation. Add `MONGODB_WAIT_QUEUE_TIMEOUT_MS=2000` and `SLOW_QUERY_MS=1000` if overriding defaults. Production startup verifies transaction-capable replica-set/mongos topology before binding HTTP, disables automatic collection/index creation and fails closed on invalid configuration. MongoDB must be private, authenticated and TLS protected; topology detection does not verify effective DB privileges, TLS policy, backups or restore capability. Keep `TRUST_PROXY_HOPS=0` unless the exact fixed ingress path is configured and direct backend access is blocked.

check:release runs lint, strict type checking, the full test suite with coverage, production build, production dependency audit and synthetic Compose validation once. CI also audits development dependencies and runs the isolated container smoke. npm run check remains available for the normal test/build cycle without coverage.

Use an operational identity to run prerequisite Phase 8 setup when installing or upgrading an older installation, then the additive Phase 9 migration and read-only preflight:

```sh
npm run db:indexes:dashboards
npm run db:indexes:production
npm run ops:preflight
```

For an existing fully migrated 0.8.0 database, only the last two commands are necessary. The production migration creates all registered collections/schema indexes plus existing target/dashboard aggregate indexes. It never calls syncIndexes, drops indexes, seeds grants/defaults, reapproves policies or rewrites business records. Earlier phase migrations remain responsible for their documented data/default setup. Missing/duplicate incompatible indexes fail rather than destructively repairing data.

Preflight reads topology, collection and index metadata; it does not write application data. It checks compound-key order, unique/sparse/TTL/partial options and hidden indexes, and exits nonzero for missing/incompatible definitions. Extra operator-managed indexes are retained. Output contains collection/index definitions and safe reason codes, no URIs or records. Run it with metadata-read privileges before every promotion; it is not a full database/IAM/backup acceptance test. Inside the runtime image use `node dist/scripts/production-indexes.js` and `node dist/scripts/production-preflight.js` with separately injected migration/metadata identities. Keep index/DDL privileges out of the normal API identity.

## Distributed quotas and data access

General and stricter authentication quotas use independent MongoDB namespaces and atomic increments, shared by all API instances with the same signing key/configuration. The stricter quota remains 30 requests per 15 minutes across login, setup, recovery, CSRF, refresh and password-change routes. General limits retain RATE_LIMIT_MAX/RATE_LIMIT_WINDOW_MS. IPv6 normalization and trusted proxy handling remain supplied by express-rate-limit. Stored keys are HMAC hashes of normalized client keys; raw IPs and credentials are not persisted. Fixed windows can permit a boundary burst of up to two windows' quotas. A JWT signing-key rotation or limit-window change starts a new quota namespace; coordinate rolling configuration and retain ingress protection.

The new request_limits collection stores `_id`, hits and expiresAt with a TTL index. API credentials require read/insert/update/delete access to this collection; TTL cleanup is server-managed. Expiration is enforced through window keys independently of TTL timing. Concurrent first-hit duplicate-key races retry once and still count the request. Store errors return 503 RATE_LIMIT_UNAVAILABLE and do not fall back to local memory. Health probes bypass quotas, so MongoDB failure does not hide liveness. These controls supplement ingress connection/body/rate limits and the existing per-account login protection; they do not replace DDoS protection.

No authorization-sensitive dashboard cache is enabled. Calculators continue to fetch current scopes/source grants, and exports continue to reauthorize at publication/download. Redis configuration remains reserved rather than pretending a connected Redis cache exists. A future cache must preserve current session/role/hierarchy revocation and source visibility, with measured benefit before introduction.

## Health, shutdown and containers

Liveness `/api/v1/health/live` stays minimal and process-only. Readiness `/api/v1/health/ready` checks a bounded DB ping and draining state. All responses use Cache-Control:no-store. During shutdown new business/readiness requests are rejected, the listener closes, active responses finish and MongoDB disconnects. SIGINT/SIGTERM and fatal handlers are registered before database startup, preventing a late HTTP bind after termination. Repeated shutdown is idempotent; a fatal event during drain preserves a nonzero result. The configured deadline closes remaining connections and forces nonzero exit if cleanup stalls. Runtime tests use real HTTP sockets and injected connection dependencies; production OS signal/container behavior is tested by the separate smoke workflow.

The Dockerfile runs compiled Node as non-root, with production-only dependencies. Its bounded healthcheck honors PORT. `docker-compose.production.yml` is an independent deployment template using an external DB: non-root image, read-only root filesystem, restricted tmpfs, dropped capabilities, no-new-privileges, PID/memory/CPU bounds, log rotation and 20-second termination grace. Its API port binds loopback; provision TLS ingress separately. Required environment references include private storage settings; the API receives configured SMTP settings to run automatic invitation/reset delivery. If delivery is isolated to a separate worker, set CREDENTIAL_DELIVERY_ENABLED=false in the API and inject SMTP settings only into that worker. Choose an approved image digest, supply environment secrets through your deployment manager and verify secret-file/log handling. The sample resource limits are starting points to measure, not established capacity claims.

```sh
docker build -t sunvika-office-api:0.9.0 .
# Inject reviewed production variables before invoking this file.
docker compose -f docker-compose.production.yml config --quiet
docker compose -f docker-compose.production.yml up -d --wait
```

Never print expanded Compose config in shared logs. `npm run validate:production-compose` validates both production and smoke definitions using synthetic settings. `npm run test:container` builds and exercises an isolated random Compose project: temporary replica set, explicit compiled migration/preflight, non-root/read-only API, custom-port readiness, authentication/docs boundaries and SIGTERM exit 0. It then removes only that invocation's project and anonymous volumes. The smoke MongoDB is deliberately unauthenticated and network-private; it is not a production DB template. The command fails visibly if Docker is unavailable. CI runs this on Linux after checks/coverage/audit and uploads coverage; it does not publish images or deploy resources.

## Operational monitoring

```http
GET /api/v1/operations/metrics
Authorization: Bearer <current-administrator-access-token>
```

This endpoint requires a live `settings:manage ALL` grant, with no role-name bypass. It rejects query parameters. It authorizes before collecting data and again before publication, so permission/session revocation during collection denies the response. Queue scans run outside hierarchy/administration write fences and have a three-second execution bound each; observations across queues need not be simultaneous. Do not scrape more frequently than needed; 60 seconds is a reasonable initial interval to measure. Use a short-lived authenticated operator session or your existing restricted monitoring bridge; no static public metrics token or anonymous operational payload is introduced.

The normal success envelope wraps:

```json
{"observedAt":"2026-10-17T12:00:00.000Z","http":{"scope":"PROCESS","requests":100,"inFlight":1,"aborted":0,"statuses":{"2xx":90,"3xx":0,"4xx":9,"5xx":1},"durationMsSum":2000,"latencyCumulativeBuckets":[{"leMs":100,"count":95}],"eventLoopUtilization":0.1,"cpuUserMicroseconds":10000,"cpuSystemMicroseconds":1000,"rssBytes":80000000,"heapUsedBytes":30000000},"database":{"scope":"PROCESS_OBSERVED_EVENTS","connections":2,"checkedOut":0,"checkoutFailures":0,"commands":300,"commandFailures":0,"slowCommands":0,"durationMsSum":400},"queues":{"credential_deliveries":[{"status":"PENDING","count":2,"oldestCreatedAt":"2026-10-17T11:59:00.000Z"}]}}
```

The example is abbreviated; actual cumulative latency buckets are 10/50/100/250/500/1000/2500/10000 ms. All completed/aborted requests contribute to total duration/count; requests slower than the final bucket remain in the total. The current scrape is included in inFlight but not completed counters. Process counters reset on restart. Database connection gauges represent events observed after client connection, not absolute server-wide pool sizes; command latency excludes time waiting for pool checkout. Do not sum shared queue gauges across API replicas. Queue groups include pending/processing/failed operational states, excluding completed/sent/expired/previews. Oldest creation time is queue age, not a worker heartbeat or retry timestamp. An empty queue cannot establish that a scheduler is running.

No customer records, employee IDs, job payloads, ciphertext, leases, storage metadata or raw provider errors appear. Normal request logs contain correlation ID, method, status and response time; paths, query strings, request bodies and headers are excluded. Slow DB command logs contain an approved operation category, duration and failed flag, never command documents, results, connection addresses or error objects. Pool wait is bounded to prevent unbounded checkout queues. Existing structured service/startup/shutdown/error logs remain redacted.

Configure alerts for sustained 5xx/503 and elevated p95 latency, abort/in-flight growth, event-loop/memory/CPU saturation, DB checkout failures/slow commands, queue backlog/oldest age, FAILED jobs and missing scheduler heartbeats from the scheduler itself. Alert thresholds need baseline measurements. Check readiness and DB/pool health first; for queue stalls inspect the relevant worker's safe exit status, provider access, lease recovery and fresh authorization. Do not reapprove evidence, broaden grants or delete audit/history to clear an operational alert. Revoked authorization/export stale failures can be legitimate terminal outcomes.

## Performance and release gates

New compound indexes match employee/branch plus kind/completion time for dashboard call/visit windows, employee plus approved milestone time, and employee/branch effective attendance time. Real replica-set tests compare scanned documents with a 1200-record synthetic history; the narrow completion window returns/examines one document rather than scanning the full employee history. Hierarchy lookups also verify bounded IXSCAN execution. Existing target and branch-approved indexes are retained. Exact target calculations and all authorization semantics remain unchanged. Indexes increase storage/write cost; confirm index sizes and representative plans in staging, and do not drop previous indexes automatically.

Use the bounded read-only load tool only against an authorized test environment:

```powershell
$env:LOAD_BASE_URL = 'http://127.0.0.1:3000'
$env:LOAD_PATH = '/api/v1/health/ready'
$env:LOAD_REQUESTS = '100'
$env:LOAD_CONCURRENCY = '5'
npm run test:load
```

For representative dashboard testing select a supported dashboard GET path/date query and inject LOAD_BEARER_TOKEN securely. Remote hosts additionally require explicit LOAD_ALLOW_REMOTE=true. The tool permits no write paths, follows no redirects, bounds requests (10000), concurrency (50) and timeout (30000 ms), drains responses without storing/logging data, emits status counts/p50/p95/p99 and exits nonzero on HTTP/network failures. It logs no target URL or token. Rate-limit 429 is a failed load result, not silently ignored; configure approved test quotas before stress testing. Health-only throughput is not dashboard throughput, and fixture query-plan tests are not a production capacity claim.

Before promotion, record representative company/subtree/branch/self dashboard and import/export load, transaction/fence contention, CPU/heap/DB pool saturation and query plans. Exercise production TLS/auth/least privileges, S3/browser CORS/versioned private downloads, SMTP invitations/resets, scheduled retries/cleanup, ingress cookies/forwarding, real signal drain, image vulnerability scan/SBOM and backup restore into an isolated environment. Document accepted limits, recovery objectives and external owner sign-off. These cannot be certified from local unit/integration tests.

Rollback code by restoring the previous approved image after stopping/draining workers. Keep additive indexes and immutable histories. Review authorization/configuration compatibility separately; do not restore old grants or drop new collections as a routine rollback. Backups must include DB data and the keys needed to decrypt queued deliveries, stored securely and independently. S3 retention/restore must preserve pinned referenced versions. No automatic attached-evidence deletion policy has been introduced.

General notification/reminder APIs, a generic audit-log browser and solar/AMC remain separate future features. They are not part of the Phase 9 production-readiness checklist in GUIDE.md and are not claimed as implemented. See VERIFICATION.md for actual local checks and environment limitations.
