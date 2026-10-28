# EC2 deployment with GitHub Actions

This deploys `sunvika-office-backend` on one Ubuntu 24.04 **amd64/x86_64** EC2 instance using the existing production Docker Compose configuration and host Nginx. The GitHub-hosted runner builds an amd64 Node 24 image; an ARM/Graviton instance needs a separate ARM build workflow. Redis is not used by this application.

`.github/workflows/ci.yml` checks the application, deployment scripts, mocked release/worker behavior and isolated container startup. After **Backend checks** succeeds for a `main` push from this repository, `.github/workflows/deploy.yaml` verifies the checked commit is still the current `main` revision, builds it, packages the image with production Compose, uploads it over verified SSH and invokes the installed deploy helper. Older successful runs, pull requests and unsuccessful checks do not deploy. These files prepare deployment; they do not provision AWS resources or certify the live environment.

## 1. Prepare AWS and DNS

- Create Ubuntu 24.04 amd64 EC2 with sufficient RAM/disk for the API, Docker images and operational jobs. Attach a stable public address and point your API DNS hostname to it.
- Allow inbound 80/443 and SSH from your administrator/runner network. Keep port 3000 closed externally; Compose publishes it only on `127.0.0.1`. GitHub-hosted runner egress addresses can change, so plan SSH connectivity or use a runner on your private network.
- Allow the instance's **outbound public IP** in MongoDB Atlas. Configure an authenticated TLS, transaction-capable replica set, backups and a restricted runtime database identity.
- Provision the versioned private S3 bucket and runtime IAM permissions described in [DEPLOYMENT.md](DEPLOYMENT.md) and [infra/SUNVIKA_S3_SETUP.md](infra/SUNVIKA_S3_SETUP.md). Prefer an EC2 instance role. For role credentials from bridged Docker containers, require IMDSv2 and configure metadata response hop limit **2**, then verify access from the container. Cleanup needs its own restricted version-delete role.
- Prepare HTTPS frontend DNS and SMTP. Production cookies use `SameSite=Strict`: frontend and API must be on the same site, for example `app.example.com` and `api.example.com`, or share an origin through a proxy. Arbitrary cross-site CORS entries do not make these cookies work.

## 2. Bootstrap the instance once

From this repository on your machine, copy the setup folder and connect (replace the key path, IP and hostname):

```powershell
scp -i "C:\keys\ec2.pem" -r deploy/ec2 ubuntu@YOUR_EC2_IP:/tmp/sunvika-office-ec2
ssh -i "C:\keys\ec2.pem" ubuntu@YOUR_EC2_IP
```

On EC2:

```sh
sudo bash /tmp/sunvika-office-ec2/setup.sh api.example.com ubuntu
```

The script installs Docker/Compose, Nginx, Certbot and Python, adds the deploy user to the Docker group, installs `/usr/local/bin/sunvika-office-deploy`, enables certificate renewal and the queue timer, and creates:

```text
/opt/sunvika-office/
  incoming/               # release upload and checksum
  releases/<release-id>/   # compose.yaml and content-addressed image.id
  current -> releases/...
  previous -> releases/...
  shared/backend.env      # root:<deploy-user-primary-group>, mode 0640
  shared/migrate.env      # optional separate migration identity
```

Reconnect SSH to activate the Docker group, and check `docker info` and `docker compose version`. Docker-group access is administrative access to this host; use a dedicated trusted deploy key. The deployment helper runs as the deploy user without sudo.

Setup preserves existing environment contents and an existing `/etc/nginx/sites-available/sunvika-office` file, including Certbot changes. It preserves other Nginx sites. The API site accepts only the configured hostname; Ubuntu's default site may still show its welcome page for other hostnames. On a dedicated instance, disable that stock site if desired with `sudo unlink /etc/nginx/sites-enabled/default`, then run `sudo nginx -t && sudo systemctl reload nginx`. Review existing sites first on a shared host.

## 3. Configure production settings and HTTPS

```sh
sudoedit /opt/sunvika-office/shared/backend.env
```

Use [deploy/ec2/backend.env.example](deploy/ec2/backend.env.example) as the checklist. Required values are the authenticated TLS `MONGODB_URI`, independent `JWT_SECRET` and `TOKEN_ENCRYPTION_KEY`, exact HTTPS `CORS_ORIGINS`, a matching `CREDENTIAL_UI_ORIGIN`, `AWS_REGION` and `S3_BUCKET`. Configure SMTP to send invitations/resets. Generate signing and encryption values independently in your private terminal:

```sh
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
python3 -c 'import secrets; print(secrets.token_hex(32))'
```

Compose reads this file as environment interpolation, not a shell script. Single-quote values containing `$` or `#`; percent-encode special characters in MongoDB URI credentials. Do not print expanded Compose configuration or upload this file to GitHub. The production Compose file enforces `NODE_ENV=production`, `DOCS_ENABLED=false` and `RATE_LIMIT_STORE=mongo`. Keep `TRUST_PROXY_HOPS=1` for this direct host-Nginx topology; adjust trust deliberately if adding a load balancer.

After DNS resolves to EC2 and ports 80/443 are reachable:

```sh
sudo certbot --nginx --redirect -d api.example.com
sudo certbot renew --dry-run
```

Nginx overwrites forwarding headers, proxies to loopback port 3000, bounds connections/requests/body size and logs request method/status without URI/query strings. A 502 is expected until the first healthy API deployment.

## 4. Set GitHub deployment configuration

Create a GitHub environment named **production** and add its secrets:

| Secret | Value |
|---|---|
| `EC2_HOST` | Stable EC2 IP or SSH hostname, without a URL scheme |
| `EC2_SSH_KEY` | Dedicated private SSH key; install its public key in the deploy user's `authorized_keys` |
| `EC2_KNOWN_HOSTS` | Verified OpenSSH known-hosts entry for this host; use `[host]:port` for a nonstandard SSH port |

Verify the server host-key fingerprint through a trusted AWS/admin channel before saving `EC2_KNOWN_HOSTS`; collecting it with `ssh-keyscan` alone does not verify it.

Generate a dedicated login key on your trusted machine with `ssh-keygen -t ed25519 -f sunvika-office-actions -C github-actions-office`, outside the repository. Leave its passphrase empty for unattended CI. Copy only `sunvika-office-actions.pub` to `/tmp/` on EC2 with your existing administrator key, then run as the deploy user:

```sh
install -d -m 0700 ~/.ssh
cat /tmp/sunvika-office-actions.pub >> ~/.ssh/authorized_keys
chmod 0600 ~/.ssh/authorized_keys
sudo cat /etc/ssh/ssh_host_ed25519_key.pub
sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

Use the server public key to construct `EC2_KNOWN_HOSTS`, for example `YOUR_EC2_IP ssh-ed25519 AAAA...`, using the exact host value configured in `EC2_HOST`. Store the complete dedicated private key as `EC2_SSH_KEY`. Verify login with that key before enabling deployments.

Add these environment variables as needed:

| Variable | Default / purpose |
|---|---|
| `EC2_USER` | `ubuntu`; must match the setup deploy user |
| `EC2_SSH_PORT` | `22` |
| `RUN_INDEX_MIGRATION` | `false`; explicitly set `true` only for a reviewed index migration |

Restrict the production environment to the intended production branch and configure environment reviewers if your release process requires them. The workflow is configured for `main`; update its branch filter and deployment condition together if your default/release branch differs.

## 5. First release and migrations

Production disables automatic collection/index creation. Before the initial deployment, create a separate migration configuration with the same application settings but a database identity that can create the required collections/indexes:

```sh
sudo cp /opt/sunvika-office/shared/backend.env /opt/sunvika-office/shared/migrate.env
sudo chown "root:$(id -gn)" /opt/sunvika-office/shared/migrate.env
sudo chmod 0640 /opt/sunvika-office/shared/migrate.env
sudoedit /opt/sunvika-office/shared/migrate.env
```

Set `RUN_INDEX_MIGRATION=true` in GitHub's production environment, push the prepared code to `main`, and monitor both workflows. The deploy helper runs compiled `production-indexes.js` with `migrate.env`, then always runs the read-only `production-preflight.js` with the normal runtime identity before switching the API. The runtime identity needs collection/index metadata access for this preflight, alongside its required application permissions. Reset `RUN_INDEX_MIGRATION=false` after the reviewed migration succeeds.

The production index migration is additive. It does **not** seed grants/defaults, approve creation policies, initialize the MD account or perform earlier data migrations. Follow [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md), [DEPLOYMENT.md](DEPLOYMENT.md) and [PHASE9.md](PHASE9.md) for fresh bootstrap or upgrades from older phases. Run the compiled operational scripts with separately injected operational configuration; `tsx` is absent from the production image. Do not bootstrap a second MD or automatically rerun bootstrap during releases.

Readiness is `/api/v1/health/ready` and liveness is `/api/v1/health/live`. Verify HTTPS readiness and an authorized business operation after the release:

```sh
curl --fail https://api.example.com/api/v1/health/ready
```

## 6. Operations, workers and rollback

To inspect the current API on EC2:

```sh
cd /opt/sunvika-office
export API_IMAGE="$(cat current/image.id)"
docker compose --project-name sunvika-office --env-file shared/backend.env --file current/compose.yaml ps
docker compose --project-name sunvika-office --env-file shared/backend.env --file current/compose.yaml logs --tail 100 api
```

Invitations/resets run in the API automatically when SMTP is configured. Setup installs `run-jobs.sh` as `/usr/local/bin/sunvika-office-jobs` and enables `sunvika-office-jobs.timer`. It starts two minutes after boot, then processes bounded commercial/import/export and dashboard batches 60 seconds after the previous run finishes. The wrapper resolves one release and image for both queues, shares the deployment lock, and skips an interval when deployment is active or the first release has not started. A commercial queue failure still allows the dashboard batch to run and marks the service failed for monitoring.

```sh
systemctl status sunvika-office-jobs.timer
systemctl list-timers sunvika-office-jobs.timer
sudo journalctl -u sunvika-office-jobs.service -n 100 --no-pager
# Run a batch immediately, or re-enable a timer that an operator disabled:
sudo systemctl start sunvika-office-jobs.service
sudo systemctl enable --now sunvika-office-jobs.timer
```

The service has a four-minute deadline and does not overlap its own runs. The commercial command runs at most five import/export iterations, and the dashboard command handles at most five export attempts; monitor backlog, runtime, failure counts and scheduler heartbeat and tune frequency from measurements. Commercial jobs stay disabled inside the API so the timer owns their scheduling.

Schedule compiled `cleanup-orphan-photos.js` hourly with a **separate** protected configuration and cleanup IAM role; the normal API identity must not gain broad delete access. If using an isolated credential-delivery schedule, set `CREDENTIAL_DELIVERY_ENABLED=false` in the API and pass SMTP/key settings only to that worker. Lease recovery/retries survive restarts, but require monitoring. See [DEPLOYMENT.md](DEPLOYMENT.md) for each worker's permissions and retention rules.

The helper serializes releases with `flock`. Release IDs contain the commit SHA, workflow run ID and attempt. It validates the archive/checksum, loads the image, pins Compose to the local `sha256` image ID, runs migration/preflight as configured, then waits for container health and checks readiness. A failed activation restores the prior release when one exists; an unsuccessful first deployment stops the API. A single API container means brief downtime during replacement; this is not a rolling deployment. A host/process crash can require manual recovery.

Automatic rollback changes the application image only and uses the current production configuration. Additive indexes, histories, data and external effects remain. Review authorization/configuration compatibility before manually restoring an older image. Preserve `current` and `previous` releases and their Docker image IDs when cleaning disk; do not prune rollback images indiscriminately. Failed release metadata may need operator cleanup after inspection.

Before live business use, complete the target-environment acceptance in [PHASE9.md](PHASE9.md): image vulnerability scan/SBOM, TLS and cookies, Atlas permissions/backups/restore, actual S3/browser CORS and version checks, SMTP delivery, worker scheduling, load/capacity and real shutdown/rollback. Local configuration checks cannot establish those results.
