#!/usr/bin/env bash
# Exercise releases and scheduled jobs with temporary data and mocked Docker.
set -euo pipefail
suite="$(mktemp -d)"
trap 'rm -rf -- "$suite"' EXIT
scripts="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$suite/bin" "$suite/fixture"
export MOCK_CALLS="$suite/calls"
export MOCK_IMAGE_ID=sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
printf '%s\n' "$MOCK_IMAGE_ID" > "$suite/fixture/image.id"
printf 'mock image\n' > "$suite/fixture/image.tar"
printf 'services: {}\n' > "$suite/fixture/compose.yaml"
cat > "$suite/bin/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$MOCK_CALLS"
if [[ "$*" == 'image inspect '* ]]; then printf '%s\n' "$MOCK_IMAGE_ID"; exit 0; fi
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
chmod +x "$suite/bin/"*
export PATH="$suite/bin:$PATH"
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
first="$sha-1-1"
second="$sha-2-1"
new_root() {
  export SUNVIKA_DEPLOY_ROOT="$suite/$1"
  mkdir -p "$SUNVIKA_DEPLOY_ROOT/"{incoming,releases,shared}
  touch "$SUNVIKA_DEPLOY_ROOT/shared/backend.env" "$SUNVIKA_DEPLOY_ROOT/shared/migrate.env"
  : > "$MOCK_CALLS"
}
package() {
  tar -czf "$SUNVIKA_DEPLOY_ROOT/incoming/$1.tar.gz" -C "$suite/fixture" image.tar image.id compose.yaml
  (cd "$SUNVIKA_DEPLOY_ROOT/incoming" && sha256sum "$1.tar.gz" > "$1.sha256")
}
expect_failure() {
  if bash "$scripts/deploy.sh" "$1" "${2:-false}"; then echo "Expected failure: $1" >&2; exit 1; fi
}
current_is() { [[ "$(basename "$(readlink -f "$SUNVIKA_DEPLOY_ROOT/current")")" == "$1" ]]; }

new_root releases
package "$first"
bash "$scripts/deploy.sh" "$first" true
current_is "$first"
grep -q production-indexes.js "$MOCK_CALLS"
grep -q production-preflight.js "$MOCK_CALLS"
package "$second"
: > "$MOCK_CALLS"
bash "$scripts/deploy.sh" "$second"
current_is "$second"
[[ "$(basename "$(readlink -f "$SUNVIKA_DEPLOY_ROOT/previous")")" == "$first" ]]
if grep -q production-indexes.js "$MOCK_CALLS"; then echo 'Unrequested migration ran' >&2; exit 1; fi
export MOCK_BAD_RELEASE="$sha-3-1"
package "$MOCK_BAD_RELEASE"
expect_failure "$MOCK_BAD_RELEASE"
current_is "$second"
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
bash "$scripts/run-jobs.sh"
grep -q process-commercial-jobs.js "$MOCK_CALLS"
grep -q process-dashboard-jobs.js "$MOCK_CALLS"
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
echo 'Deployment tests passed: activation, migration/preflight, rollback, first-release failure, checksum, scheduled jobs and lock contention.'
