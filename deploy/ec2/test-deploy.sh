#!/usr/bin/env bash
# Exercise releases and scheduled jobs with temporary data and mocked Docker.
set -euo pipefail
suite="$(mktemp -d)"
trap 'rm -rf -- "$suite"' EXIT
scripts="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$suite/bin" "$suite/fixture"
export MOCK_CALLS="$suite/calls"
export MOCK_ENV_CALLS="$suite/env-calls"
export MOCK_IMAGE_CALLS="$suite/image-calls"
export MOCK_LOADED_ARCHIVE="$suite/loaded.tar"
export MOCK_WRONG_IMAGE_ARCHIVE="$suite/fixture/wrong-image.tar"
printf 'services: {}\n' > "$suite/fixture/compose.yaml"
cat > "$suite/bin/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$MOCK_CALLS"
printf '%s|%s\n' "${API_IMAGE:-}" "$*" >> "$MOCK_IMAGE_CALLS"
args=("$@")
for ((index=0; index<${#args[@]}; index++)); do
  if [[ "${args[index]}" == --env-file ]]; then
    env_hash="$(sha256sum "${args[index+1]}" | cut -d ' ' -f 1)"
    printf '%s|%s\n' "$*" "$env_hash" >> "$MOCK_ENV_CALLS"
    break
  fi
done
if [[ "$1 $2" == 'image load' ]]; then
  [[ "${MOCK_IMAGE_LOAD_FAIL:-false}" != true ]] || exit 1
  [[ "$3" == --input ]]
  cp -- "$4" "$MOCK_LOADED_ARCHIVE"
  printf 'Loaded image: %s\n' "$MOCK_IMAGE_TAG"
  exit 0
fi
if [[ "$1 $2" == 'image inspect' ]]; then
  [[ "${MOCK_IMAGE_INSPECT_FAIL:-false}" != true ]] || exit 1
  [[ "$3" == --format && "$4" == '{{json .}}' ]]
  [[ "$5" == "$MOCK_IMAGE_TAG" || "$5" == "$MOCK_IMAGE_ID" ]]
  python3 - <<'PY'
import json, os
print(json.dumps({"Id": os.environ["MOCK_IMAGE_ID"],
                  "RepoTags": [os.environ["MOCK_IMAGE_TAG"]],
                  "Os": "linux", "Architecture": "amd64"}))
PY
  exit 0
fi
if [[ "$1 $2" == 'image save' ]]; then
  [[ "${MOCK_IMAGE_SAVE_FAIL:-false}" != true ]] || exit 1
  [[ "$3" == "$MOCK_IMAGE_ID" && "$#" == 3 ]]
  if [[ "${MOCK_WRONG_EXPORTED_CONFIG:-false}" == true ]]; then
    cat -- "$MOCK_WRONG_IMAGE_ARCHIVE"
  else
    cat -- "$MOCK_LOADED_ARCHIVE"
  fi
  exit 0
fi
if [[ "${MOCK_PREFLIGHT_FAIL:-false}" == true && "$*" == *production-preflight.js* ]]; then exit 1; fi
if [[ "${MOCK_MIGRATION_FAIL:-false}" == true && "$*" == *production-indexes.js* ]]; then exit 1; fi
if [[ "${MOCK_COMMERCIAL_FAIL:-false}" == true && "$*" == *process-commercial-jobs.js* ]]; then exit 1; fi
if [[ -n "${MOCK_BAD_RELEASE:-}" && "$*" == *"/releases/$MOCK_BAD_RELEASE/compose.yaml up "* ]]; then exit 1; fi
exit 0
EOF
cat > "$suite/bin/curl" <<'EOF'
#!/usr/bin/env bash
if [[ -n "${MOCK_HEALTH_BAD_RELEASE:-}" && "$(readlink -f "$SUNVIKA_DEPLOY_ROOT/current")" == *"/$MOCK_HEALTH_BAD_RELEASE" ]]; then exit 1; fi
exit 0
EOF
# Exercise the real installation/rename commands without requiring root in CI.
cat > "$suite/bin/sudo" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == -n ]]
shift
if [[ "$1" == install ]]; then
  if [[ "${MOCK_ENV_RESTORE_FAIL:-false}" == true && "$*" == *'/.backend.env.previous '* ]]; then exit 1; fi
  shift
  args=()
  while (( $# )); do
    if [[ "$1" == -o ]]; then shift 2; else args+=("$1"); shift; fi
  done
  exec install "${args[@]}"
fi
exec "$@"
EOF
chmod +x "$suite/bin/"*
export PATH="$suite/bin:$PATH"
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
first="$sha-1-1"
second="$sha-2-1"
new_root() {
  export SUNVIKA_DEPLOY_ROOT="$suite/$1"
  mkdir -p "$SUNVIKA_DEPLOY_ROOT/"{incoming,releases,shared}
  printf 'VALUE=original\n' > "$SUNVIKA_DEPLOY_ROOT/shared/backend.env"
  printf 'VALUE=stale-migration\n' > "$SUNVIKA_DEPLOY_ROOT/shared/migrate.env"
  : > "$MOCK_CALLS"
  : > "$MOCK_ENV_CALLS"
  : > "$MOCK_IMAGE_CALLS"
}
package() {
  export MOCK_IMAGE_TAG="sunvika-office-api:$1"
  # Deliberately use a host-local manifest ID distinct from the portable config.
  # Each release also has a distinct ID, so rollback tests can catch wrong pins.
  MOCK_IMAGE_ID="sha256:$(printf '%s' "$1" | sha256sum | cut -d ' ' -f 1)"
  export MOCK_IMAGE_ID
  python3 - "$suite/fixture" "$MOCK_IMAGE_TAG" <<'PY'
import hashlib, io, json, os, sys, tarfile
from pathlib import Path
folder = Path(sys.argv[1])
tag = os.environ.get("MOCK_ARCHIVE_TAG", sys.argv[2])
config = {"architecture": os.environ.get("MOCK_ARCHIVE_ARCH", "amd64"),
          "os": "linux", "config": {"Cmd": ["node"]},
          "rootfs": {"type": "layers", "diff_ids": []}, "history": []}
def image_archive(path, value):
    raw = json.dumps(value, separators=(",", ":")).encode()
    digest = hashlib.sha256(raw).hexdigest()
    config_name = digest + ".json"
    manifest = json.dumps([{"Config": config_name, "RepoTags": [tag], "Layers": []}]).encode()
    with tarfile.open(path, "w") as archive:
        for name, data in ((config_name, raw), ("manifest.json", manifest)):
            entry = tarfile.TarInfo(name)
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
    return "sha256:" + digest
config_id = image_archive(folder / "image.tar", config)
(folder / "image.config.id").write_text(os.environ.get("MOCK_CONFIG_ID", config_id) + "\n")
config["config"] = {"Cmd": ["wrong-image"]}
image_archive(folder / "wrong-image.tar", config)
PY
  cp -- "$scripts/image_identity.py" "$suite/fixture/image_identity.py"
  tar -czf "$SUNVIKA_DEPLOY_ROOT/incoming/$1.tar.gz" -C "$suite/fixture" image.tar image.config.id image_identity.py compose.yaml
  (cd "$SUNVIKA_DEPLOY_ROOT/incoming" && sha256sum "$1.tar.gz" > "$1.sha256")
}
expect_failure() {
  if bash "$scripts/deploy.sh" "$1" "${2:-false}" "${3:-host}"; then echo "Expected failure: $1" >&2; exit 1; fi
}
current_is() { [[ "$(basename "$(readlink -f "$SUNVIKA_DEPLOY_ROOT/current")")" == "$1" ]]; }

new_root releases
package "$first"
bash "$scripts/deploy.sh" "$first" true
current_is "$first"
first_image_id="$MOCK_IMAGE_ID"
[[ "$(cat "$SUNVIKA_DEPLOY_ROOT/current/image.id")" == "$first_image_id" ]]
[[ "$first_image_id" != "$(cat "$SUNVIKA_DEPLOY_ROOT/current/image.config.id")" ]]
grep -Fq "image save $first_image_id" "$MOCK_CALLS"
grep -q production-indexes.js "$MOCK_CALLS"
grep -q production-preflight.js "$MOCK_CALLS"
package "$second"
: > "$MOCK_CALLS"
bash "$scripts/deploy.sh" "$second"
current_is "$second"
second_image_id="$MOCK_IMAGE_ID"
[[ "$second_image_id" != "$first_image_id" ]]
[[ "$(cat "$SUNVIKA_DEPLOY_ROOT/current/image.id")" == "$second_image_id" ]]
[[ "$(basename "$(readlink -f "$SUNVIKA_DEPLOY_ROOT/previous")")" == "$first" ]]
if grep -q production-indexes.js "$MOCK_CALLS"; then echo 'Unrequested migration ran' >&2; exit 1; fi
export MOCK_BAD_RELEASE="$sha-3-1"
package "$MOCK_BAD_RELEASE"
: > "$MOCK_IMAGE_CALLS"
expect_failure "$MOCK_BAD_RELEASE"
current_is "$second"
grep -Fq "$second_image_id|compose --project-name sunvika-office --env-file $SUNVIKA_DEPLOY_ROOT/shared/backend.env --file $SUNVIKA_DEPLOY_ROOT/releases/$second/compose.yaml up " "$MOCK_IMAGE_CALLS"
unset MOCK_BAD_RELEASE
export MOCK_HEALTH_BAD_RELEASE="$sha-6-1"
package "$MOCK_HEALTH_BAD_RELEASE"
expect_failure "$MOCK_HEALTH_BAD_RELEASE"
current_is "$second"
unset MOCK_HEALTH_BAD_RELEASE
package "$sha-4-1"
export MOCK_PREFLIGHT_FAIL=true
expect_failure "$sha-4-1"
current_is "$second"
unset MOCK_PREFLIGHT_FAIL
package "$sha-5-1"
export MOCK_MIGRATION_FAIL=true
expect_failure "$sha-5-1" true
current_is "$second"
unset MOCK_MIGRATION_FAIL

: > "$MOCK_CALLS"
: > "$MOCK_IMAGE_CALLS"
bash "$scripts/run-jobs.sh"
grep -q process-commercial-jobs.js "$MOCK_CALLS"
grep -q process-dashboard-jobs.js "$MOCK_CALLS"
[[ "$(cut -d '|' -f 1 "$MOCK_IMAGE_CALLS" | sort -u)" == "$second_image_id" ]]
: > "$MOCK_CALLS"
export MOCK_COMMERCIAL_FAIL=true
if bash "$scripts/run-jobs.sh"; then echo 'Worker failure was hidden' >&2; exit 1; fi
grep -q process-dashboard-jobs.js "$MOCK_CALLS"
unset MOCK_COMMERCIAL_FAIL
# A held deployment lock must skip queued work without invoking Docker.
: > "$MOCK_CALLS"
exec 8> "$SUNVIKA_DEPLOY_ROOT/.deploy.lock"
flock 8
bash "$scripts/run-jobs.sh"
[[ ! -s "$MOCK_CALLS" ]]
flock -u 8
exec 8>&-

new_root first-failure
export MOCK_BAD_RELEASE="$first"
package "$first"
expect_failure "$first"
[[ ! -L "$SUNVIKA_DEPLOY_ROOT/current" ]]
grep -q 'stop api' "$MOCK_CALLS"
unset MOCK_BAD_RELEASE
: > "$MOCK_CALLS"
bash "$scripts/run-jobs.sh"
[[ ! -s "$MOCK_CALLS" ]]

new_root checksum
package "$first"
printf 'tampered\n' >> "$SUNVIKA_DEPLOY_ROOT/incoming/$first.tar.gz"
expect_failure "$first"
[[ ! -d "$SUNVIKA_DEPLOY_ROOT/releases/$first" ]]
[[ ! -s "$MOCK_CALLS" ]]
expect_failure '../../invalid'
stage_config() {
  local config="$SUNVIKA_DEPLOY_ROOT/incoming/$1-config"
  install -d -m 0700 "$config"
  printf 'VALUE=%s\n' "${2:-candidate}" > "$config/backend.env"
  chmod 0600 "$config/backend.env"
  if [[ "${3:-false}" == true ]]; then
    printf 'VALUE=migration-candidate\n' > "$config/migrate.env"
    chmod 0600 "$config/migrate.env"
  fi
}
config_is() { [[ "$(cat "$SUNVIKA_DEPLOY_ROOT/shared/backend.env")" == "VALUE=$1" ]]; }
no_private_material() {
  [[ ! -e "$SUNVIKA_DEPLOY_ROOT/incoming/$1-config" ]]
  [[ ! -e "$SUNVIKA_DEPLOY_ROOT/releases/$1/.backend.env.previous" ]]
  [[ -z "$(find "$SUNVIKA_DEPLOY_ROOT/shared" -name '.backend.env.*' -print -quit)" ]]
}

new_root github-config
package "$first"
stage_config "$first" candidate true
bash "$scripts/deploy.sh" "$first" true github
current_is "$first"
config_is candidate
[[ "$(stat -c '%a' "$SUNVIKA_DEPLOY_ROOT/shared/backend.env")" == 640 ]]
[[ "$(stat -c '%G' "$SUNVIKA_DEPLOY_ROOT/shared/backend.env")" == "$(id -gn "$(id -un)")" ]]
no_private_material "$first"
migration_hash="$(printf 'VALUE=migration-candidate\n' | sha256sum | cut -d ' ' -f 1)"
grep -q "production-indexes.js|$migration_hash" "$MOCK_ENV_CALLS"

# A changed runtime configuration is installed with its image, without silently
# invoking an old migration configuration from shared/migrate.env.
package "$second"
stage_config "$second" second
: > "$MOCK_CALLS"
bash "$scripts/deploy.sh" "$second" false github
current_is "$second"
config_is second
if grep -q production-indexes.js "$MOCK_CALLS"; then echo 'Stale migration identity was used' >&2; exit 1; fi
no_private_material "$second"

third="$sha-3-1"
package "$third"
stage_config "$third" rejected-preflight true
export MOCK_PREFLIGHT_FAIL=true
expect_failure "$third" true github
unset MOCK_PREFLIGHT_FAIL
current_is "$second"
config_is second
no_private_material "$third"

fourth="$sha-4-1"
package "$fourth"
stage_config "$fourth" rejected-migration true
export MOCK_MIGRATION_FAIL=true
expect_failure "$fourth" true github
unset MOCK_MIGRATION_FAIL
current_is "$second"
config_is second
no_private_material "$fourth"

fifth="$sha-5-1"
package "$fifth"
stage_config "$fifth" rejected-startup
export MOCK_BAD_RELEASE="$fifth"
: > "$MOCK_ENV_CALLS"
expect_failure "$fifth" false github
unset MOCK_BAD_RELEASE
current_is "$second"
config_is second
no_private_material "$fifth"
second_hash="$(printf 'VALUE=second\n' | sha256sum | cut -d ' ' -f 1)"
grep -q "/releases/$second/compose.yaml up .*|$second_hash" "$MOCK_ENV_CALLS"

sixth="$sha-6-1"
package "$sixth"
stage_config "$sixth" rejected-health
export MOCK_HEALTH_BAD_RELEASE="$sixth"
expect_failure "$sixth" false github
unset MOCK_HEALTH_BAD_RELEASE
current_is "$second"
config_is second
no_private_material "$sixth"

# Migration mode must never fall back to the old shared migration file.
seventh="$sha-7-1"
package "$seventh"
stage_config "$seventh" missing-migration
expect_failure "$seventh" true github
current_is "$second"
config_is second
no_private_material "$seventh"

new_root github-first-failure
package "$first"
stage_config "$first" first-failure true
export MOCK_BAD_RELEASE="$first"
expect_failure "$first" true github
unset MOCK_BAD_RELEASE
[[ ! -L "$SUNVIKA_DEPLOY_ROOT/current" ]]
config_is original
no_private_material "$first"
grep -q 'stop api' "$MOCK_CALLS"

# Preserve the only previous configuration if the atomic rollback installation
# itself fails; still remove staged migration credentials and temporary files.
new_root github-restore-failure
package "$first"
stage_config "$first" recoverable
bash "$scripts/deploy.sh" "$first" false github
package "$second"
stage_config "$second" rejected true
export MOCK_BAD_RELEASE="$second" MOCK_ENV_RESTORE_FAIL=true
: > "$MOCK_CALLS"
expect_failure "$second" true github > "$suite/restore-failure-output" 2>&1
unset MOCK_BAD_RELEASE MOCK_ENV_RESTORE_FAIL
backup="$SUNVIKA_DEPLOY_ROOT/releases/$second/.backend.env.previous"
[[ "$(cat "$backup")" == VALUE=recoverable ]]
[[ "$(stat -c '%a' "$backup")" == 600 ]]
grep -Fq "Previous environment retained at $backup (mode 0600)." "$suite/restore-failure-output"
[[ ! -e "$SUNVIKA_DEPLOY_ROOT/incoming/$second-config" ]]
[[ -z "$(find "$SUNVIKA_DEPLOY_ROOT/shared" -name '.backend.env.*' -print -quit)" ]]
if grep -q "/releases/$first/compose.yaml up " "$MOCK_CALLS"; then
  echo 'Previous image restarted with unrestored configuration' >&2
  exit 1
fi

new_root github-checksum
package "$first"
stage_config "$first" candidate true
printf 'tampered\n' >> "$SUNVIKA_DEPLOY_ROOT/incoming/$first.tar.gz"
expect_failure "$first" true github
config_is original
no_private_material "$first"
[[ ! -d "$SUNVIKA_DEPLOY_ROOT/releases/$first" ]]

# Invalid or mismatched transported images must never change a running release
# or install its candidate configuration, including when Docker commands fail.
new_root image-identity
package "$first"
stage_config "$first" accepted
bash "$scripts/deploy.sh" "$first" false github
accepted_image_id="$MOCK_IMAGE_ID"
identity_case=20
for issue in archive-tag config-mismatch malformed-config platform load inspect export loaded-config; do
  identity_case=$((identity_case + 1))
  candidate="$sha-$identity_case-1"
  case "$issue" in
    archive-tag) export MOCK_ARCHIVE_TAG=sunvika-office-api:wrong-release ;;
    config-mismatch) export MOCK_CONFIG_ID=sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff ;;
    malformed-config) export MOCK_CONFIG_ID=not-an-image-digest ;;
    platform) export MOCK_ARCHIVE_ARCH=arm64 ;;
    load) export MOCK_IMAGE_LOAD_FAIL=true ;;
    inspect) export MOCK_IMAGE_INSPECT_FAIL=true ;;
    export) export MOCK_IMAGE_SAVE_FAIL=true ;;
    loaded-config) export MOCK_WRONG_EXPORTED_CONFIG=true ;;
  esac
  package "$candidate"
  stage_config "$candidate" rejected true
  : > "$MOCK_CALLS"
  expect_failure "$candidate" true github
  unset MOCK_ARCHIVE_TAG MOCK_CONFIG_ID MOCK_ARCHIVE_ARCH MOCK_IMAGE_LOAD_FAIL \
    MOCK_IMAGE_INSPECT_FAIL MOCK_IMAGE_SAVE_FAIL MOCK_WRONG_EXPORTED_CONFIG
  current_is "$first"
  config_is accepted
  [[ "$(cat "$SUNVIKA_DEPLOY_ROOT/current/image.id")" == "$accepted_image_id" ]]
  [[ ! -e "$SUNVIKA_DEPLOY_ROOT/releases/$candidate/image.id" ]]
  no_private_material "$candidate"
  if grep -q '^compose ' "$MOCK_CALLS"; then
    echo "Unverified image reached Compose: $issue" >&2
    exit 1
  fi
  case "$issue" in
    archive-tag|config-mismatch|malformed-config|platform) [[ ! -s "$MOCK_CALLS" ]] ;;
  esac
done

echo 'Deployment tests passed: portable image identity, host-local pins, activation, migration/preflight, image and configuration rollback, private-file cleanup, checksum, scheduled jobs and lock contention.'
