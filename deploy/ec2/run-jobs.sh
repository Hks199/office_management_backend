#!/usr/bin/env bash
# Process bounded commercial and dashboard queue batches from one installed release.
set -euo pipefail
umask 027

fail() { printf 'Job runner failed: %s\n' "$*" >&2; exit 1; }
root="${SUNVIKA_DEPLOY_ROOT:-/opt/sunvika-office}"
[[ -d "$root" ]] || fail 'deployment root does not exist'
root="$(cd -- "$root" && pwd -P)"
cd -- "$root"

# Use exactly the deployment helper's lock; never wait behind a promotion.
exec 9> .deploy.lock
if flock -n -E 75 9; then
  :
else
  lock_status=$?
  if (( lock_status == 75 )); then
    printf 'Deployment or another job run is active; skipping this interval.\n'
    exit 0
  fi
  fail 'could not acquire deployment lock'
fi
if [[ ! -e current && ! -L current ]]; then
  printf 'No current release yet; skipping this interval.\n'
  exit 0
fi

release="$(readlink -f -- current)" || fail 'cannot resolve current release'
[[ -d "$release" && "$release" == "$root/releases/"* ]] || fail 'current must resolve inside releases'
[[ -f "$release/compose.yaml" && -f "$release/image.id" ]] || fail 'release metadata is missing'
[[ -r "$root/shared/backend.env" ]] || fail 'production environment file is unreadable'
image_id="$(cat -- "$release/image.id")"
[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || fail 'release image ID is invalid'

run_queue() {
  API_IMAGE="$image_id" docker compose \
    --project-name sunvika-office --env-file "$root/shared/backend.env" \
    --file "$release/compose.yaml" run --rm -T --no-deps --pull never \
    api node "dist/scripts/$1"
}

status=0
if ! run_queue process-commercial-jobs.js; then
  printf 'Commercial queue processing failed.\n' >&2
  status=1
fi
if ! run_queue process-dashboard-jobs.js; then
  printf 'Dashboard queue processing failed.\n' >&2
  status=1
fi
exit "$status"
