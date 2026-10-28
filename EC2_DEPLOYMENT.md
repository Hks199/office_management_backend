# EC2 deployment with GitHub Actions

This deploys `sunvika-office-backend` on one Ubuntu 24.04 or 26.04 **amd64/x86_64** EC2 instance using the existing production Docker Compose configuration and host Nginx. The GitHub-hosted runner builds a Node 24 image explicitly for `linux/amd64`; an ARM/Graviton instance needs a separate ARM build workflow. Redis is not used by this application.

`.github/workflows/ci.yml` checks the application, deployment scripts, mocked release/worker behavior and isolated container startup. After **Backend checks** succeeds for a `main` push from this repository, `.github/workflows/deploy.yaml` verifies the checked commit is still the current `main` revision, builds it, packages the image with production Compose, renders the application environment from GitHub secrets/variables, uploads the release, checked deployment helper and private configuration over verified SSH, refreshes the installed helper, and invokes it. You can also start deployment with **Run workflow** on `main`; this requires successful **Backend checks** for a push of that exact current-main commit. Older successful runs, pull requests and unsuccessful checks do not deploy. These files prepare deployment; they do not provision AWS resources or certify the live environment.

The **Backend checks** job temporarily uses the Ubuntu 22.04 runner because MongoDB 8's startup guard rejects the newer kernel on some Ubuntu 24.04 GitHub runners ([upstream runner issue](https://github.com/actions/runner-images/issues/15005)). MongoDB 8 and the full container smoke checks remain enabled. The smoke log records the Docker server's version, kernel and operating system. Deployment jobs and the EC2 operating system are independent of this CI runner selection. Revisit this workaround after the MongoDB image includes the upstream Ubuntu kernel-detection fix.

## 1. Prepare AWS and DNS

- Create Ubuntu 24.04 or 26.04 amd64 EC2 with sufficient RAM/disk for the API, Docker images and operational jobs. Attach a stable public address and point your API DNS hostname to it.
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
sudo bash /tmp/sunvika-office-ec2/setup.sh sunvika.niakylie.com ubuntu
```

If the repository is already cloned on EC2, update and run its setup script instead:

```sh
cd ~/office_management_backend
git pull --ff-only origin main
sudo bash deploy/ec2/setup.sh sunvika.niakylie.com ubuntu
```

The script installs Docker/Compose, Nginx, Certbot and Python, adds the deploy user to the Docker group, installs `/usr/local/bin/sunvika-office-deploy`, enables certificate renewal and the queue timer, and creates:

```text
/opt/sunvika-office/
  incoming/               # release upload and checksum
  releases/<release-id>/   # Compose, config digest, host image ID and verifier
  current -> releases/...
  previous -> releases/...
  shared/backend.env      # root:<deploy-user-primary-group>, mode 0640
```

Reconnect SSH to activate the Docker group, and check `docker info` and `docker compose version`. Docker-group access is administrative access to this host; use a dedicated trusted deploy key. The deployment helper runs as the deploy user and uses passwordless `sudo` to install the root-owned runtime environment atomically. The deploy user must be allowed to install the checked deployment helper as root and run its `install`/`mv` operations without an interactive password; the standard Ubuntu EC2 `ubuntu` administrator normally has this access.

The one-time host bootstrap is still required. On subsequent GitHub deployments, the workflow uploads `deploy/ec2/deploy.sh` from the checked commit and installs it as root-owned mode 0755 at `/usr/local/bin/sunvika-office-deploy` using `sudo -n install` before transferring application configuration and invoking the helper. You do not need to rerun setup solely to refresh this helper; changes to other installed host services still require the relevant host update.

Each checksummed release archive contains exactly `image.tar`, `image.config.id`, `image_identity.py` and `compose.yaml`. The portable `image.config.id` is the SHA256 of the image's raw configuration JSON, which includes its layer identities. The helper verifies this digest, the release tag and the `linux/amd64` platform before loading the image. It then resolves the loaded image on EC2 and verifies its configuration digest again using a streamed Docker export, without writing another full image archive to disk. Only after that succeeds does it create `image.id` containing the immutable image ID understood by the EC2 Docker daemon.

Docker's classic and containerd image stores can report different IDs for the same image, so the runner's image ID is not assumed to be portable. Production Compose, scheduled jobs and rollback continue to use the verified EC2-local `image.id`; `image.config.id` remains with the release as verification metadata. The verifier travels inside the checked release archive and the workflow refreshes `deploy.sh` automatically, so this fix needs no additional manual helper installation on EC2.

Setup preserves existing environment contents and an existing `/etc/nginx/sites-available/sunvika-office` file, including Certbot changes. It preserves other Nginx sites. The API site accepts only the configured hostname; Ubuntu's default site may still show its welcome page for other hostnames. On a dedicated instance, disable that stock site if desired with `sudo unlink /etc/nginx/sites-enabled/default`, then run `sudo nginx -t && sudo systemctl reload nginx`. Review existing sites first on a shared host.

## 3. Configure production settings in GitHub

Application settings come from the GitHub secrets and variables you already configured. **Do not manually upload a local `.env` or edit the EC2 runtime file for this workflow.** Create/use the **production** GitHub environment under repository **Settings > Environments**, or use repository-level **Settings > Secrets and variables > Actions**. The deployment job uses the `production` environment; its values take precedence over matching repository values.

For each application setting, the workflow reads a nonempty GitHub **secret first**, then a **variable with the same name**, then its documented optional default. Configure these seven required names with real production values:

| Name | Recommended location | Purpose |
|---|---|---|
| `MONGODB_URI` | Secret | Authenticated TLS MongoDB URI for the runtime database identity |
| `JWT_SECRET` | Secret | Independent signing secret |
| `TOKEN_ENCRYPTION_KEY` | Secret | Independent 64-character hexadecimal encryption key |
| `CORS_ORIGINS` | Variable | Exact HTTPS frontend origin(s) |
| `CREDENTIAL_UI_ORIGIN` | Variable | HTTPS frontend origin used for invitation/reset links |
| `AWS_REGION` | Variable | Region of the configured S3 bucket |
| `S3_BUCKET` | Variable | Private versioned S3 bucket name |

Keep credentials and signing/encryption keys in **Secrets**. Keep ordinary settings in **Variables**. Do not paste their real values into workflow YAML, logs or committed files. Generate signing and encryption values independently if they are not already configured:

```sh
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
python3 -c 'import secrets; print(secrets.token_hex(32))'
```

Other names listed in [deploy/ec2/backend.env.example](deploy/ec2/backend.env.example) are optional GitHub secrets/variables with defaults: proxy trust, log/rate-limit/database tuning, body/shutdown limits, JWT issuer/audience and lifetimes, commercial-job scheduling, credential-delivery interval and SMTP settings. The GitHub workflow and host template default `CREDENTIAL_DELIVERY_ENABLED=false` so email is not sent before frontend/SMTP setup. Configure `SMTP_PASSWORD` and other credentials as Secrets. Keep `TRUST_PROXY_HOPS=1` for this direct host-Nginx topology; adjust trust deliberately if adding a load balancer.

If your frontend is not ready, use temporary `CORS_ORIGINS=https://sunvika.niakylie.com` and `CREDENTIAL_UI_ORIGIN=https://sunvika.niakylie.com`, and leave `CREDENTIAL_DELIVERY_ENABLED=false`. Replace both origins with the actual frontend HTTPS address and configure SMTP before enabling invitations/resets. Production cookies use `SameSite=Strict`, so frontend/API must share the same site or origin.

For the local Vite frontend proxy, append `http://localhost:5173` to the existing `CORS_ORIGINS` list, for example `https://sunvika.niakylie.com,http://localhost:5173`. Production validation permits HTTP only for this exact local origin. Preserve the other trusted origins and update the GitHub setting so the next deployment keeps the change.

The workflow writes a private mode-0600 interpolation file, transfers it over SSH, and the deploy helper installs it as `/opt/sunvika-office/shared/backend.env` with root ownership and mode 0640 under the deployment lock. Values are quoted for Compose without printing them. The production Compose file enforces `NODE_ENV=production`, `DOCS_ENABLED=false` and `RATE_LIMIT_STORE=mongo`; other arbitrary GitHub values are not forwarded. Use an EC2 instance role for AWS credentials rather than expecting static AWS access keys to be forwarded.

After DNS resolves to EC2 and ports 80/443 are reachable, configure HTTPS:

```sh
sudo certbot --nginx --redirect -d sunvika.niakylie.com
sudo certbot renew --dry-run
```

Nginx overwrites forwarding headers, proxies to loopback port 3000, bounds connections/requests/body size and logs request method/status without URI/query strings. A 502 is expected until the first healthy API deployment.

## 4. Set GitHub deployment configuration

In the **production** GitHub environment (or repository Actions secrets), keep these SSH secrets configured:

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
| `RUN_INDEX_MIGRATION` | `false`; set `true` for the initial collection/index creation or a reviewed index migration |

Restrict the production environment to the intended production branch and configure environment reviewers if your release process requires them. The workflow is configured for `main`; update its branch filter and deployment condition together if your default/release branch differs.

## 5. First release and migrations

Production disables automatic collection/index creation. For the initial deployment, set `RUN_INDEX_MIGRATION=true` in GitHub's production environment. Optionally add **`MIGRATION_MONGODB_URI`** as a GitHub Secret for a separate database identity permitted to create collections/indexes in the same database. If it is absent, migration uses `MONGODB_URI`, whose identity must then have those permissions. Migration receives the same application settings as the new runtime configuration with only this URI overridden; it does not reuse a stale host `migrate.env`. Its private staging file is removed after deployment.

Push the prepared code to `main` and wait for **Backend checks** on that commit to succeed. Its successful push run triggers deployment automatically. If the code is already pushed but checks need rerunning, open **Actions > Backend checks > the latest current-main push run > Re-run all jobs**.

If EC2 has no `current/image.id`, an empty `releases/` directory and no application container, the host is prepared but no release is active. To start a deployment explicitly:

1. Make sure the updated workflow is pushed to `main` and **Backend checks** has succeeded for that exact commit.
2. Open **Actions > Deploy office backend to EC2 > Run workflow**.
3. Select branch **main**, then select **Run workflow**. Keep `RUN_INDEX_MIGRATION=true` for the first deployment as described above.
4. Open the new run and check its job summary. The eligibility check requires the selected commit to remain current `main` and the latest `ci.yml` push run for that exact commit, from this repository, to have completed successfully. Manual deployment does not bypass CI.
5. Open the deployment job's **Check deployment server** step. Compare its hostname with the EC2 terminal you intend to deploy to (for example, `ip-172-31-2-140`). Privately compare the instance's current public IPv4 in the AWS console with the `EC2_HOST` GitHub secret; an IP change or different host can explain a release missing from your terminal. Do not print the secret in logs.
6. Wait for the final verification and a **Deployed** job summary showing the activated release and successful local readiness check. Then reset `RUN_INDEX_MIGRATION=false`.

A green workflow can contain skipped deployment jobs. For an older main commit, a pull request or unsuccessful checks, the eligibility summary explains **Skipped** and no release is deployed. Read the summary and the `package`/`deploy` job statuses rather than relying only on the workflow's green icon. If retrying a failed deployment run, choose **Re-run all jobs**, because release/artifact names include the run attempt and a deploy-only retry can refer to an earlier attempt's package.

If an older deployment passed its upload checksum and then failed with `No such image: sha256:...`, commit and push the image-identity fix to `main`, wait for **Backend checks** on that new commit, and let its automatic deployment finish or use **Run workflow** on the new current `main`. Re-running a workflow for the old commit does not pick up this fix. If the new run itself needs retrying, use **Re-run all jobs** so packaging and deployment share the same attempt. Leave existing failed release files in place while inspecting them; the new commit/run attempt gets a new release directory.

The deploy helper runs compiled `production-indexes.js` with the generated migration configuration, then always runs the read-only `production-preflight.js` with the new runtime identity before activating the release. The runtime identity needs collection/index metadata access for this preflight, alongside its required application permissions. Reset `RUN_INDEX_MIGRATION=false` after the reviewed migration succeeds. A first deployment can create the runtime environment automatically; no application environment upload is needed.

The helper still supports the optional host-managed mode when invoked manually without the GitHub-managed third argument. That mode reads the existing protected host configuration, including `shared/migrate.env` when a migration is requested; it is not the normal GitHub workflow path.

The production index migration is additive. It does **not** seed grants/defaults, approve creation policies, initialize the MD account or perform earlier data migrations. Follow [ENVIRONMENT_SETUP.md](ENVIRONMENT_SETUP.md), [DEPLOYMENT.md](DEPLOYMENT.md) and [PHASE9.md](PHASE9.md) for fresh bootstrap or upgrades from older phases. Run the compiled operational scripts with separately injected operational configuration; `tsx` is absent from the production image. Do not bootstrap a second MD or automatically rerun bootstrap during releases.

Readiness is `/api/v1/health/ready` and liveness is `/api/v1/health/live`. Verify HTTPS readiness and an authorized business operation after the release:

```sh
curl --fail https://sunvika.niakylie.com/api/v1/health/ready
```

## 6. Operations, workers and rollback

After a successful deployment has created `current/image.id`, inspect the current API on EC2. If that file is missing, follow the first-release recovery in section 5 before running these Compose commands:

```sh
cd /opt/sunvika-office
export API_IMAGE="$(cat current/image.id)"
docker compose --project-name sunvika-office --env-file shared/backend.env --file current/compose.yaml ps
docker compose --project-name sunvika-office --env-file shared/backend.env --file current/compose.yaml logs --tail 100 api
```

Invitations/resets run in the API automatically when SMTP is configured and `CREDENTIAL_DELIVERY_ENABLED=true`. Setup installs `run-jobs.sh` as `/usr/local/bin/sunvika-office-jobs` and enables `sunvika-office-jobs.timer`. It starts two minutes after boot, then processes bounded commercial/import/export and dashboard batches 60 seconds after the previous run finishes. The wrapper resolves one release and image for both queues, shares the deployment lock, and skips an interval when deployment is active or the first release has not started. A commercial queue failure still allows the dashboard batch to run and marks the service failed for monitoring.

```sh
systemctl status sunvika-office-jobs.timer
systemctl list-timers sunvika-office-jobs.timer
sudo journalctl -u sunvika-office-jobs.service -n 100 --no-pager
# Run a batch immediately, or re-enable a timer that an operator disabled:
sudo systemctl start sunvika-office-jobs.service
sudo systemctl enable --now sunvika-office-jobs.timer
```

The service has a four-minute deadline and does not overlap its own runs. The commercial command runs at most five import/export iterations, and the dashboard command handles at most five export attempts; monitor backlog, runtime, failure counts and scheduler heartbeat and tune frequency from measurements. Keep `COMMERCIAL_JOBS_ENABLED=false` inside the API so the timer owns their scheduling; `COMMERCIAL_JOBS_INTERVAL_MS` is forwarded as an optional application setting if you deliberately choose a different scheduling arrangement.

Schedule compiled `cleanup-orphan-photos.js` hourly with a **separate** protected configuration and cleanup IAM role; the normal API identity must not gain broad delete access. If using an isolated credential-delivery schedule, set `CREDENTIAL_DELIVERY_ENABLED=false` in the API and pass SMTP/key settings only to that worker. Lease recovery/retries survive restarts, but require monitoring. See [DEPLOYMENT.md](DEPLOYMENT.md) for each worker's permissions and retention rules.

The helper serializes releases with `flock`. Release IDs contain the commit SHA, workflow run ID and attempt. It validates the archive/checksum, loads the image, pins Compose to the local `sha256` image ID, runs migration/preflight as configured, then waits for container health and checks readiness. A failed activation restores the prior release when one exists; an unsuccessful first deployment stops the API. A single API container means brief downtime during replacement; this is not a rolling deployment. A host/process crash can require manual recovery.

For GitHub-managed deployments, activation installs the new runtime configuration atomically under the deployment lock. If activation fails, automatic rollback restores the previous runtime configuration together with the previous application release; a failed first deployment restores the prior configuration state. Additive indexes, histories, data and external effects remain. Review authorization/configuration compatibility before manually restoring an older image. Preserve `current` and `previous` releases and their Docker image IDs when cleaning disk; do not prune rollback images indiscriminately. Failed release metadata may need operator cleanup after inspection.

Before live business use, complete the target-environment acceptance in [PHASE9.md](PHASE9.md): image vulnerability scan/SBOM, TLS and cookies, Atlas permissions/backups/restore, actual S3/browser CORS and version checks, SMTP delivery, worker scheduling, load/capacity and real shutdown/rollback. Local configuration checks cannot establish those results.
