#!/usr/bin/env bash
set -euo pipefail
umask 027

release="${1:-}"
migrate="${2:-false}"
config_source="${3:-host}"
[[ "$release" =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ ]] || { echo 'Invalid release ID.' >&2; exit 1; }
[[ "$migrate" == true || "$migrate" == false ]] || { echo 'Migration option must be true or false.' >&2; exit 1; }
[[ "$config_source" == host || "$config_source" == github ]] || { echo 'Configuration source must be host or github.' >&2; exit 1; }
root="${SUNVIKA_DEPLOY_ROOT:-/opt/sunvika-office}"
cd "$root"
root="$(pwd -P)"
config_dir="$root/incoming/$release-config"
config_snapshot=''
config_temp=''
config_changed=false
rollback_enabled=false
previous=''
target="$root/releases/$release"
runtime_env="$root/shared/backend.env"
migration_env="$root/shared/migrate.env"
deploy_account="$(id -un)"
# The account primary group remains correct after an interactive newgrp docker.
deploy_group="$(id -gn "$deploy_account")"

compose_at() {
  local folder="$1" env_file="$2"
  shift 2
  API_IMAGE="$(cat "$folder/image.id")" docker compose \
    --project-name sunvika-office --env-file "$env_file" --file "$folder/compose.yaml" "$@"
}
activate() {
  ln -sfn "$1" "$root/.current-next"
  mv -Tf "$root/.current-next" "$root/current"
}
install_runtime_env() {
  local source_file="$1"
  if [[ -n "$config_temp" ]]; then
    sudo -n rm -f -- "$config_temp" || return
    config_temp=''
  fi
  config_temp="$(sudo -n mktemp "$root/shared/.backend.env.XXXXXX")" || return
  sudo -n install -o root -g "$deploy_group" -m 0640 -- "$source_file" "$config_temp" || return
  sudo -n mv -Tf -- "$config_temp" "$root/shared/backend.env" || return
  config_temp=''
}
finish() {
  local status=$? restored=true
  set +e
  trap - EXIT HUP INT TERM
  if (( status != 0 )) && [[ "$rollback_enabled" == true ]]; then
    if [[ "$config_changed" == true ]]; then
      if ! install_runtime_env "$config_snapshot"; then
        restored=false
        echo 'ROLLBACK FAILED. Could not restore the previous environment.' >&2
      fi
    fi
    if [[ "$restored" == true && -n "$previous" ]]; then
      echo 'Deployment failed; restoring the previous image and environment.' >&2
      if activate "$previous" && compose_at "$previous" "$root/shared/backend.env" up -d --no-build --pull never --wait --wait-timeout 120 api \
        && curl --fail --silent --max-time 10 http://127.0.0.1:3000/api/v1/health/ready >/dev/null; then
        echo 'Previous deployment restored.' >&2
      else
        echo 'ROLLBACK FAILED. Inspect Docker logs and database connectivity.' >&2
      fi
    elif [[ -z "$previous" ]]; then
      # The restored first-deployment template can be incomplete; stop with the
      # validated candidate instead so interpolation cannot prevent cleanup.
      compose_at "$target" "$runtime_env" stop api || true
      rm -f "$root/current"
      echo 'First deployment failed; no previous release exists.' >&2
    fi
  fi
  if [[ -n "$config_temp" ]] && ! sudo -n rm -f -- "$config_temp"; then
    echo 'Could not remove temporary environment material.' >&2
    (( status != 0 )) || status=1
  fi
  if [[ "$restored" == false && -n "$config_snapshot" ]]; then
    # Keep the only recoverable copy if sudo/filesystem failure prevents rollback.
    printf 'Previous environment retained at %s (mode 0600).\n' "$config_snapshot" >&2
  elif [[ -n "$config_snapshot" ]] && ! rm -f -- "$config_snapshot"; then
    echo 'Could not remove the private environment backup.' >&2
    (( status != 0 )) || status=1
  fi
  if [[ "$config_source" == github && -d "$config_dir" && ! -L "$config_dir" ]]; then
    if ! rm -f -- "$config_dir/backend.env" "$config_dir/migrate.env" || ! rmdir -- "$config_dir"; then
      echo 'Could not remove staged environment material.' >&2
      (( status != 0 )) || status=1
    fi
  fi
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
exec 9> .deploy.lock
flock -w 600 9
[[ -r shared/backend.env ]] || { echo 'Configure shared/backend.env first.' >&2; exit 1; }
previous="$(readlink -f current 2>/dev/null || true)"
[[ -d "$previous" ]] || previous=''
[[ ! -e "$target" ]] || { echo 'Release already exists; rerun the workflow for a new attempt.' >&2; exit 1; }
if [[ "$config_source" == github ]]; then
  [[ -d "$config_dir" && ! -L "$config_dir" ]] || { echo 'Missing private GitHub configuration directory.' >&2; exit 1; }
  runtime_env="$config_dir/backend.env"
  migration_env="$config_dir/migrate.env"
  [[ -f "$runtime_env" && ! -L "$runtime_env" && -r "$runtime_env" ]] || { echo 'Missing staged runtime configuration.' >&2; exit 1; }
  if [[ "$migrate" == true ]]; then
    [[ -f "$migration_env" && ! -L "$migration_env" && -r "$migration_env" ]] || { echo 'Missing staged migration configuration.' >&2; exit 1; }
  fi
fi

cd incoming
read -r expected _ < "$release.sha256"
[[ "$expected" =~ ^[a-f0-9]{64}$ ]]
printf '%s  %s\n' "$expected" "$release.tar.gz" | sha256sum --check --status
python3 - "$release.tar.gz" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    entries = list(archive)
    if (sorted(entry.name for entry in entries) != ['compose.yaml', 'image.config.id', 'image.tar', 'image_identity.py']
            or any(not entry.isfile() for entry in entries)):
        raise SystemExit('Unexpected release archive contents')
PY
mkdir "$target"
tar -xzf "$release.tar.gz" -C "$target" --no-same-owner --no-same-permissions
image_ref="sunvika-office-api:$release"
config_id="$(cat "$target/image.config.id")"
[[ "$config_id" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid packaged image config digest.' >&2; exit 1; }
archive_config_id="$(python3 "$target/image_identity.py" archive "$target/image.tar" "$image_ref")"
[[ "$archive_config_id" == "$config_id" ]] || { echo 'Packaged image config digest does not match the image archive.' >&2; exit 1; }
printf 'Verified packaged image config: %s\n' "$config_id"
printf 'Loading release image: %s\n' "$image_ref"
docker image load --input "$target/image.tar"
# Image IDs can change between classic and containerd image stores. Verify the
# loaded image's portable config digest before pinning its host-local image ID.
image_id="$(python3 "$target/image_identity.py" resolve "$image_ref" "$config_id")"
[[ "$image_id" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid loaded image ID.' >&2; exit 1; }
printf '%s\n' "$image_id" > "$target/image.id"
printf 'Verified EC2 image: %s (config %s)\n' "$image_id" "$config_id"
# Keep only the installed image and small release metadata after loading.
rm -- "$target/image.tar"

compose_at "$target" "$runtime_env" config --quiet
if [[ "$migrate" == true ]]; then
  [[ -r "$migration_env" ]] || { echo 'Provide the migration configuration with its DB identity.' >&2; exit 1; }
  compose_at "$target" "$migration_env" run --rm -T --no-deps --pull never \
    api node dist/scripts/production-indexes.js
fi
# Validate the candidate before changing the running deployment or its settings.
compose_at "$target" "$runtime_env" run --rm -T --no-deps --pull never \
  api node dist/scripts/production-preflight.js

if [[ "$config_source" == github ]]; then
  config_snapshot="$target/.backend.env.previous"
  install -m 0600 -- "$root/shared/backend.env" "$config_snapshot"
fi
rollback_enabled=true
if [[ "$config_source" == github ]]; then
  # Mark first so a failed installation also restores the original configuration.
  config_changed=true
  install_runtime_env "$runtime_env"
fi
activate "$target"
compose_at "$target" "$root/shared/backend.env" up -d --no-build --pull never --wait --wait-timeout 120 api
curl --fail --silent --max-time 10 http://127.0.0.1:3000/api/v1/health/ready >/dev/null
if [[ -n "$previous" ]]; then ln -sfn "$previous" "$root/previous"; fi
rollback_enabled=false
rm -f "$root/incoming/$release.tar.gz" "$root/incoming/$release.sha256"

echo "Deployed $release with pinned image $image_id."
