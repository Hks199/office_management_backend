#!/usr/bin/env bash
set -euo pipefail
umask 027

release="${1:-}"
migrate="${2:-false}"
[[ "$release" =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ ]] || { echo 'Invalid release ID.' >&2; exit 1; }
[[ "$migrate" == true || "$migrate" == false ]] || { echo 'Migration option must be true or false.' >&2; exit 1; }
root="${SUNVIKA_DEPLOY_ROOT:-/opt/sunvika-office}"
cd "$root"
exec 9> .deploy.lock
flock -w 600 9
[[ -r shared/backend.env ]] || { echo 'Configure shared/backend.env first.' >&2; exit 1; }
previous="$(readlink -f current 2>/dev/null || true)"
[[ -d "$previous" ]] || previous=''
target="$root/releases/$release"
[[ ! -e "$target" ]] || { echo 'Release already exists; rerun the workflow for a new attempt.' >&2; exit 1; }

cd incoming
read -r expected _ < "$release.sha256"
[[ "$expected" =~ ^[a-f0-9]{64}$ ]]
printf '%s  %s\n' "$expected" "$release.tar.gz" | sha256sum --check --status
python3 - "$release.tar.gz" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    entries = list(archive)
    if (sorted(entry.name for entry in entries) != ['compose.yaml', 'image.id', 'image.tar']
            or any(not entry.isfile() for entry in entries)):
        raise SystemExit('Unexpected release archive contents')
PY
mkdir "$target"
tar -xzf "$release.tar.gz" -C "$target" --no-same-owner --no-same-permissions
docker image load --input "$target/image.tar" >/dev/null
image_id="$(cat "$target/image.id")"
[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]]
[[ "$(docker image inspect --format '{{.Id}}' "$image_id")" == "$image_id" ]]
# Keep only the installed image and small release metadata after loading.
rm -- "$target/image.tar"

compose_at() {
  local folder="$1" env_file="$2"
  shift 2
  API_IMAGE="$(cat "$folder/image.id")" docker compose \
    --project-name sunvika-office --env-file "$env_file" --file "$folder/compose.yaml" "$@"
}
compose_at "$target" "$root/shared/backend.env" config --quiet
if [[ "$migrate" == true ]]; then
  [[ -r "$root/shared/migrate.env" ]] || { echo 'Provide shared/migrate.env with the migration DB identity.' >&2; exit 1; }
  compose_at "$target" "$root/shared/migrate.env" run --rm -T --no-deps --pull never \
    api node dist/scripts/production-indexes.js
fi
# Fails before changing the running deployment if collections/indexes are missing.
compose_at "$target" "$root/shared/backend.env" run --rm -T --no-deps --pull never \
  api node dist/scripts/production-preflight.js

activate() {
  ln -sfn "$1" "$root/.current-next"
  mv -Tf "$root/.current-next" "$root/current"
}
rollback_on_error() {
  local status=$?
  trap - EXIT HUP INT TERM
  if (( status != 0 )); then
    if [[ -n "$previous" ]]; then
      echo 'Deployment failed; restoring the previous image.' >&2
      activate "$previous"
      if compose_at "$previous" "$root/shared/backend.env" up -d --no-build --pull never --wait --wait-timeout 120 api \
        && curl --fail --silent --max-time 10 http://127.0.0.1:3000/api/v1/health/ready >/dev/null; then
        echo 'Previous deployment restored.' >&2
      else
        echo 'ROLLBACK FAILED. Inspect Docker logs and database connectivity.' >&2
      fi
    else
      compose_at "$target" "$root/shared/backend.env" stop api || true
      rm -f "$root/current"
      echo 'First deployment failed; no previous release exists.' >&2
    fi
  fi
  exit "$status"
}
trap rollback_on_error EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
activate "$target"
compose_at "$target" "$root/shared/backend.env" up -d --no-build --pull never --wait --wait-timeout 120 api
curl --fail --silent --max-time 10 http://127.0.0.1:3000/api/v1/health/ready >/dev/null
if [[ -n "$previous" ]]; then ln -sfn "$previous" "$root/previous"; fi
trap - EXIT HUP INT TERM
rm -f "$root/incoming/$release.tar.gz" "$root/incoming/$release.sha256"
echo "Deployed $release with pinned image $image_id."
