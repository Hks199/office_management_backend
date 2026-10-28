#!/usr/bin/env bash
# Ubuntu 24.04 amd64 bootstrap; application secrets and first migration are explicit steps.
set -Eeuo pipefail

fail() { printf 'Setup failed: %s\n' "$*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail 'run with sudo bash deploy/ec2/setup.sh <api-domain> [deploy-user]'
[[ $# -ge 1 && $# -le 2 ]] || fail 'usage: setup.sh <api-domain> [deploy-user=ubuntu]'
api_domain="${1,,}"
deploy_user="${2:-ubuntu}"
[[ ${#api_domain} -le 253 && "$api_domain" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || fail 'supply a DNS hostname such as api.example.com'
[[ "$deploy_user" =~ ^[a-z_][a-z0-9_-]*$ && "$deploy_user" != root ]] || fail 'choose an existing non-root Linux deploy user'
id "$deploy_user" >/dev/null 2>&1 || fail 'deploy user must already exist'
deploy_group="$(id -gn "$deploy_user")"
# shellcheck disable=SC1091
source /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || fail 'this setup supports Ubuntu 24.04'
[[ "$(dpkg --print-architecture)" == amd64 ]] || fail 'the workflow image requires an amd64/x86_64 EC2 instance'
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
for source_file in deploy.sh run-jobs.sh sunvika-office-jobs.service sunvika-office-jobs.timer nginx.conf backend.env.example; do
  [[ -f "$script_dir/$source_file" ]] || fail "missing $script_dir/$source_file"
done

apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2 nginx certbot python3-certbot-nginx python3 ca-certificates curl
systemctl enable --now docker
usermod -aG docker "$deploy_user"

app_root=/opt/sunvika-office
[[ ! -L "$app_root" ]] || fail 'application root must not be a symlink'
for app_dir in "$app_root" "$app_root/releases" "$app_root/incoming"; do
  [[ ! -L "$app_dir" ]] || fail "refusing symlink: $app_dir"
  install -d -o "$deploy_user" -g "$deploy_group" -m 0750 "$app_dir"
done
[[ ! -L "$app_root/shared" ]] || fail 'shared directory must not be a symlink'
install -d -o root -g "$deploy_group" -m 0750 "$app_root/shared"
for secret_file in backend.env migrate.env; do
  [[ ! -L "$app_root/shared/$secret_file" ]] || fail 'secret files must not be symlinks'
done
if [[ ! -e "$app_root/shared/backend.env" ]]; then
  install -o root -g "$deploy_group" -m 0640 "$script_dir/backend.env.example" "$app_root/shared/backend.env"
fi
for secret_file in backend.env migrate.env; do
  if [[ -e "$app_root/shared/$secret_file" ]]; then
    [[ -f "$app_root/shared/$secret_file" ]] || fail 'secret path must be a regular file'
    chown "root:$deploy_group" "$app_root/shared/$secret_file"
    chmod 0640 "$app_root/shared/$secret_file"
  fi
done
install -o root -g root -m 0755 "$script_dir/deploy.sh" /usr/local/bin/sunvika-office-deploy
install -o root -g root -m 0755 "$script_dir/run-jobs.sh" /usr/local/bin/sunvika-office-jobs
sed -e "s/__DEPLOY_USER__/$deploy_user/g" -e "s/__DEPLOY_GROUP__/$deploy_group/g" \
  "$script_dir/sunvika-office-jobs.service" > /etc/systemd/system/sunvika-office-jobs.service
install -o root -g root -m 0644 "$script_dir/sunvika-office-jobs.timer" /etc/systemd/system/sunvika-office-jobs.timer
systemctl daemon-reload
systemctl enable --now sunvika-office-jobs.timer

site_available=/etc/nginx/sites-available/sunvika-office
site_enabled=/etc/nginx/sites-enabled/sunvika-office
[[ ! -L "$site_available" ]] || fail 'Nginx site file must not be a symlink'
if [[ ! -e "$site_available" ]]; then
  candidate="$(mktemp)"
  trap 'rm -f -- "${candidate:-}"' EXIT
  sed "s/__API_DOMAIN__/$api_domain/g" "$script_dir/nginx.conf" >"$candidate"
  install -o root -g root -m 0644 "$candidate" "$site_available"
  rm -f -- "$candidate"
  trap - EXIT
else
  printf 'Existing Nginx site retained, including any Certbot HTTPS settings: %s\n' "$site_available"
fi
if [[ ! -e "$site_enabled" && ! -L "$site_enabled" ]]; then
  ln -s "$site_available" "$site_enabled"
else
  [[ "$(readlink -f -- "$site_enabled")" == "$site_available" ]] || fail 'existing enabled Nginx site points elsewhere; review it manually'
fi
nginx -t
systemctl enable --now nginx
systemctl reload nginx
systemctl enable --now certbot.timer
printf '\nEC2 host prepared. Reconnect SSH so the Docker group is active.\n'
printf 'Configure production settings with: sudoedit %s/shared/backend.env\n' "$app_root"
printf 'After DNS resolves here and ports 80/443 are open: sudo certbot --nginx --redirect -d %s\n' "$api_domain"
printf 'Follow EC2_DEPLOYMENT.md for the separate migration identity, GitHub settings and first deployment.\n'
