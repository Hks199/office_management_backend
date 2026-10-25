# Environment setup

## Prerequisites and install

Version 0.9.0 production requires RATE_LIMIT_STORE=mongo; memory remains a single-process development/test option. New defaults are MONGODB_WAIT_QUEUE_TIMEOUT_MS=2000 and SLOW_QUERY_MS=1000. No new dependency, secret or Redis service is required. Run db:indexes:production with the migration identity and ops:preflight with metadata-read privileges before traffic. Production startup requires a transaction-capable topology and disables automatic collection/index creation. The separate docker-compose.production.yml requires authenticated TLS MongoDB, HTTPS origins, independent secrets and existing private S3 settings. See PHASE9.md for compiled commands, worker credentials and live acceptance.

Use Node 24 LTS with its npm, a MongoDB replica set (local MongoDB 8.0 supported), and optionally Docker Desktop in Linux-container mode. Node 24 is the selected LTS line according to the [official release schedule](https://nodejs.org/en/about/previous-releases). Install current security patches on deployment hosts; the workspace runtime used for verification is reported separately.

Run `npm ci`, copy `.env.example` to `.env`, generate the required JWT_SECRET and TOKEN_ENCRYPTION_KEY with the commands in README.md, and adjust the URI/origin. Never commit `.env` or credentials. `npm run dev` watches TypeScript. `npm run build` and `npm start` run compiled output. Tests do not consume your local `.env` or connect to your real application database.

## Environment variables

| Variable | Default / constraint |
|---|---|
| NODE_ENV | development; test/production accepted |
| HOST | 0.0.0.0 |
| PORT | 3000; integer 1–65535 |
| LOG_LEVEL | info; fatal/error/warn/info/debug/trace/silent |
| MONGODB_URI | Required mongodb:// or mongodb+srv:// URI; production uses authenticated TLS replica set |
| MONGODB_MAX_POOL_SIZE | 20; integer 1–200 |
| MONGODB_SERVER_SELECTION_TIMEOUT_MS | 5000; 100–30000 |
| CORS_ORIGINS | http://localhost:5173; comma-separated exact origins, no wildcards/trailing slash/path/credentials; HTTPS required in production |
| TRUST_PROXY_HOPS | 0; 0–5; only set after restricting ingress topology |
| BODY_LIMIT_BYTES | 102400; 1024–1048576 |
| RATE_LIMIT_WINDOW_MS | 60000; 1000–3600000 |
| RATE_LIMIT_MAX | 100; 1–100000, per IP/process |
| DOCS_ENABLED | false; explicit true for development; production requires false |
| SHUTDOWN_TIMEOUT_MS | 10000; 1000–60000 |
| AWS_REGION | Optional matched pair with S3_BUCKET; required for photo operations |
| S3_BUCKET | Optional matched pair with AWS_REGION; private versioned encrypted bucket required |
| REDIS_URL | Optional redis:// or rediss:// URI; not used by Phase 1 |

`.env.example` enables local documentation explicitly. Phase 2 requires independent signing and credential-encryption keys; never use example/test keys in deployment. S3 retention and general job settings remain future work. Configuration errors expose variable names only, never supplied values. No code logs the MongoDB URI.

## MongoDB locally

```sh
docker compose up -d mongo
docker compose ps
```

Healthcheck initializes `rs0` and waits for its primary. Running the API in Compose uses `mongodb://mongo:27017/sunvika?replicaSet=rs0`; a host API uses `mongodb://127.0.0.1:27017/sunvika?replicaSet=rs0&directConnection=true`. For a native MongoDB installation, launch `mongod --replSet rs0 --bind_ip 127.0.0.1`, then initialize via `mongosh` with `rs.initiate({_id:'rs0',members:[{_id:0,host:'127.0.0.1:27017'}]})`. Local examples deliberately have no authentication and must never be exposed on a public interface.

Production uses an authenticated private replica set or managed MongoDB, encryption in transit, dedicated application credentials and tested backups. Do not use `directConnection=true` with a production multi-node cluster: allow normal replica discovery/failover. Automatic indexes are disabled in production; deploy indexes with future versioned migrations.

## AWS S3 setup for Phase 4

Provision private bucket, public-access block, TLS-only policy, encryption and least-privilege IAM role per SECURITY.md. Set region and bucket, use the standard AWS workload credential provider chain. Allow only frontend HTTPS origins in bucket CORS, scoped upload methods/headers, no wildcard credentials. Configure optional KMS and scanning before accepting documents. Confirm signatures, size, checksum and ownership on completion. No AWS client/credentials/remote calls exist in Phase 1; live upload and download cannot be tested yet.

## Redis setup for later phases

```sh
docker compose --profile cache up -d redis
```

Local URI: `redis://127.0.0.1:6379`. Any future production integration requires a private TLS endpoint with ACL credentials, bounded memory and approved eviction/persistence policy. Version 0.9.0 uses MongoDB for shared quotas/jobs and connects no Redis client; the optional Compose service remains preparation only. Dashboard authorization/results are not cached.

## Secure MD bootstrap (implemented Phase 2)

Configure these identity values in your private .env: BOOTSTRAP_EMPLOYEE_CODE, BOOTSTRAP_FIRST_NAME, BOOTSTRAP_LAST_NAME, BOOTSTRAP_EMAIL, BOOTSTRAP_MOBILE_NUMBER (E.164). Configure SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER/SMTP_PASSWORD if required, and MAIL_FROM for delivery. Both SMTP credentials must be set together; MAIL_FROM is required when SMTP_HOST is set. Plain SMTP without TLS is not supported: port 587 uses STARTTLS, port 465 uses SMTP_SECURE=true.

```sh
npm run db:indexes:identity
npm run bootstrap:md
npm run dev
```

Bootstrap atomically seeds the controlled registry, six system roles and creation policies, creates the only initial MD (no password), and queues an encrypted, expiring invitation. It rejects repeat bootstrap even if the account was later deactivated. No plaintext password/token is printed. Worker sends the link through SMTP; accept-invitation consumes it once and configures Argon2id credentials. The frontend must implement the setup/reset pages using URL-fragment tokens. If an invitation expires, set INVITATION_EMPLOYEE_CODE and run `npm run invite:reissue` in the restricted operational environment, leave the API running for automatic delivery. This audited command only accepts active employees without a password, invalidates prior invitations, and never deletes/rebootstraps the root.

`npm run seed:permissions` updates controlled registry definitions; `npm run seed:roles` requires the bootstrapped active MD and preserves existing grants. `db:indexes:identity` is the explicit production identity-index migration. The API starts its delivery worker automatically when SMTP is configured, sends a batch immediately and polls every five seconds. Each batch claims up to 50 jobs, leases for two minutes, retries failures after one minute and stops retrying after five attempts. Batches do not overlap; shutdown stops new claims and waits for the active batch within the service shutdown deadline. A restart resumes pending jobs and expired leases from MongoDB. `npm run deliver:credentials` remains an optional manual drain. Set `CREDENTIAL_DELIVERY_ENABLED=false` if a separate scheduled worker owns delivery.

Investigate FAILED jobs with restricted database access: `lastErrorCode` contains only a safe category such as `SMTP_AUTHENTICATION_FAILED`, `SMTP_CONNECTION_FAILED`, `SMTP_TIMEOUT` or `SMTP_REJECTED`. Never dump ciphertext or recipient payloads into logs. After correcting SMTP, jobs below five attempts retry automatically. For expired invitations or exhausted retries, reissue the invitation using the restricted command above. A crash after sending and before recording success can duplicate delivery, but cannot allow token reuse. SENT means SMTP accepted the message; check provider delivery logs and recipient spam folders for inbox placement.

## Phase 2 configuration

| Variable | Default / requirement |
|---|---|
| JWT_SECRET | Required independent random secret, 48-512 characters; generate 48 random bytes as base64url |
| TOKEN_ENCRYPTION_KEY | Required independent 32-byte AES key encoded as 64 hexadecimal characters |
| JWT_ISSUER / JWT_AUDIENCE | sunvika-office-api / sunvika-office-web |
| ACCESS_TTL_SECONDS | 600; integer 60-900 |
| REFRESH_TTL_DAYS | 7; 1-14, no greater than absolute lifetime |
| REFRESH_ABSOLUTE_DAYS | 30; 1-90 |
| CREDENTIAL_UI_ORIGIN | http://localhost:5173; must exactly match one CORS_ORIGINS entry, HTTPS in production |
| SMTP_HOST / MAIL_FROM | Optional for API startup, required to run credential delivery |
| SMTP_PORT / SMTP_SECURE | 587 / false; secure=true for implicit TLS |
| SMTP_USER / SMTP_PASSWORD | Optional matched pair, secret-managed |
| CREDENTIAL_DELIVERY_ENABLED | true; starts automatic delivery with the API when SMTP is configured |
| CREDENTIAL_DELIVERY_INTERVAL_MS | 5000; integer 1000-60000, interval between completed batches |

Changing JWT_SECRET invalidates existing access tokens and changes CSRF derivation; plan a session revocation and controlled rotation. Changing TOKEN_ENCRYPTION_KEY requires draining existing encrypted deliveries or reissuing credentials; otherwise pending messages cannot decrypt. Do not silently discard undelivered invitations. Credential tokens expire after 30 minutes (reset) or 24 hours (invitation), enforced in database queries independently of TTL cleanup.

Cookies are HttpOnly, SameSite=Strict and Secure in production. Deploy frontend and API on the same site or proxy /api through the frontend origin; arbitrary unrelated CORS origins do not make Strict cookies cross-site. Cookie-authenticated refresh/logout need an allowed Origin and X-CSRF-Token. Bearer authentication remains separate.

## Troubleshooting

Readiness 503: MongoDB ping fails or shutdown has begun. Startup failure before port binding: check required variables, URI connectivity, credentials and replica primary availability without pasting secrets into logs. CORS 403: the full Origin must exactly match the configured allowlist. Development docs 404: enable `DOCS_ENABLED=true` outside production. Docker pipe error: start Docker Desktop's Linux engine. First integration run may need MongoDB binary download access; set `MONGOMS_SYSTEM_BINARY` to a compatible local `mongod` if downloads are prohibited.

## Phase 3 organization setup

After upgrading from Phase 2 run `npm run db:indexes:organization` using an operational database identity. Fresh databases still require MD bootstrap first to establish the root and controlled roles. No new secrets are required. The migration creates branch/location collections and indexes and fills metadata defaults without granting new arbitrary permissions or silently approving changed templates.

Create approved state/district/block data through authenticated admin APIs before creating branches. Then create branches and authorized employees with active manager/role references. MD can assign company-wide BDOs with branchId:null and make initial branch assignments. Lower managers may only place employees in their currently authorized branch set. Employee invitations are delivered automatically while the API is running and SMTP is configured.

Optional vetted master-data seeding: set LOCATION_SEED_FILE to an existing UTF-8 JSON file and run `npm run seed:locations`. Files are limited to 5 MiB and 500 total location records per transaction. See PHASE3.md for shape. The command preserves matching records, rejects unknown keys and rolls back conflicting names/kinds. It does not fetch, invent or hardcode administrative geography. Break larger vetted datasets into reviewed idempotent batches.

Roles/policies changed after Phase 2 can require reapproval: GET the policy, review its current creator/target roles, then PUT it with its current policy revision and complete fields. Server captures current role revisions. Existing invalid legacy user branch/manager references require explicit review/correction; migration does not silently reparent employees or move historical data.

## Phase 4 attendance setup

Configure AWS_REGION and S3_BUCKET together; IAM credentials come from the AWS default credential chain, preferably a workload role. See PHASE4.md and infra/private-photos.yaml for required private bucket versioning, encryption, public access blocks, exact-origin CORS and separate runtime/cleanup policies. No endpoint override, public bucket or local filesystem fallback exists. Missing configuration makes photo uploads fail closed.

Run `npm run db:indexes:attendance` using the operational DB identity. Set branch attendancePolicy through an ALL-authorized branch administrator only when office hours/geofences are approved; defaults do not assume either. Schedule `npm run cleanup:orphan-photos` hourly with restricted cleanup IAM credentials. It deletes only unattached uploads expired over 24 hours ago and retains metadata for failed retries; never attached evidence.

## Phase 5 commercial setup

No new application secrets or Redis configuration are required. Run `npm run db:indexes:commercial` with the migration identity. Existing installations must review `npm run enable:commercial-capabilities` to add missing default receive-assignment grants; it requires initialized active bootstrap administration, audits/increments changed role revisions and deliberately requires affected creation policies to be reapproved. Custom eligible roles need reviewed grants through role administration. Fresh bootstrap already includes the default capabilities.

Create approved PAYMENT_MODE/PANEL_BRAND/PANEL_TECHNOLOGY/LEAD_SOURCE values using /reference-values before creating leads; no real reference catalog is seeded. Review BRANCH versus COMPANY customer dedupe before the first committed customer. Configure the same private S3 bucket and expanded import/export IAM prefixes/CORS from infra/private-photos.yaml. Schedule `npm run jobs:commercial` every minute and keep orphan cleanup scheduled under its separate cleanup role. The worker processes durable leased jobs, rechecks the current session/permissions and does not run in the HTTP process. Jobs initiated by a revoked/expired session need an authorized reconfirmation or new preview; see PHASE5.md.

## Phase 6 reporting setup

No new environment secrets are required. Run `npm run db:indexes:reports` on the configured replica set before enabling report traffic (compiled image: `node dist/scripts/report-indexes.js`). Review report grants and existing receive-assignment capabilities for upgraded/custom roles. Site photo operations use AWS_REGION/S3_BUCKET, IAM credentials and the versioned/private/encrypted bucket from Phase 4; deploy the added site-visits prefix permissions in infra/private-photos.yaml. Tests use temporary replica sets and injected storage. See PHASE6.md.

## Phase 7 targets

No new environment secrets are needed. Before routing version 0.7.0 traffic, run `npm run db:indexes:targets` (compiled runtime: `node dist/scripts/target-indexes.js`). This creates prerequisite and target/evidence indexes without changing grants. New lead events capture pending evidence atomically; historical lead events can be captured through the scoped target-evidence API, then independently verified. Existing report reviews govern call/visit actuals. Configure insert/read-only privileges for target_revisions and target_evidence_reviews. See PHASE7.md for default period, eligibility, attribution and approval policies.

## Phase 8 analytics setup

No new secrets or dependencies are required. Run `npm run db:indexes:dashboards` (runtime: `node dist/scripts/dashboard-indexes.js`) before version 0.8.0 traffic; schedule `npm run jobs:dashboards` (runtime: `node dist/scripts/process-dashboard-jobs.js`) for private CSV jobs. Existing AWS_REGION/S3_BUCKET/IAM/versioned encrypted private exports prefix is reused. Configure each branch working calendar through the ALL-settings-authorized dashboard calendar API; no office weekday/holiday defaults are fabricated. Existing role grants are preserved. See PHASE8.md.
