#!/usr/bin/env bash
# Sets up a fresh Debian server for Vibeship, or updates one: run it again
# after `git pull` to rebuild and restart Vibeship. Every step checks before
# it changes anything, so running it twice is safe.
#
#   sudo VIBESHIP_HOST=vibeship.hiranyey.dev \
#        ADMIN_EMAILS=you@example.com \
#        ORIGIN_CERT=/root/origin.pem ORIGIN_KEY=/root/origin.key \
#        OIDC_ISSUER=https://clerk.hiranyey.dev OIDC_CLIENT_ID=... OIDC_CLIENT_SECRET=... \
#        scripts/bootstrap.sh
#
# Settings (environment variables). Ones marked "kept" are remembered in
# $STACK_ROOT/vibeship/.env, so a re-run needs only VIBESHIP_HOST:
#   VIBESHIP_HOST       Vibeship's own hostname (required)
#   BASE_DOMAIN         apps live at <project>.BASE_DOMAIN (default: VIBESHIP_HOST
#                       minus its first label) (kept)
#   ADMIN_EMAILS        comma-separated emails allowed to log in (kept; required)
#   OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET
#                       the Clerk production instance (kept; without them only
#                       API tokens work)
#   ORIGIN_CERT, ORIGIN_KEY
#                       the Cloudflare origin certificate and key for
#                       *.BASE_DOMAIN (needed on the first run; copied in)
#   MASTER_KEY          restore an existing database's key on a new server
#                       (default: generate one on the first run) (kept)
#   VIBESHIP_IMAGE      a prebuilt image (default: build vibeship:local from
#                       this checkout)
#   CLOUDFLARE_ONLY=1   accept 443 only from Cloudflare's IP ranges
#   SSH_PORT            the port to keep open for SSH (default 22)
#   STACK_ROOT          default /opt/stack
#   SKIP_PACKAGES=1, SKIP_FIREWALL=1
#                       skip installing packages or setting up the firewall,
#                       e.g. to test the rest on a machine that has Docker
set -euo pipefail
umask 022

REPO="$(cd "$(dirname "$0")/.." && pwd)"
STACK_ROOT="${STACK_ROOT:-/opt/stack}"
SSH_PORT="${SSH_PORT:-22}"
ADMIN_SUBNET="172.31.250.0/24"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }
die() { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Reads KEY's value from an env file written by this script ('quoted' values).
env_get() {
  [[ -f "$2" ]] || return 0
  sed -n "s/^$1=//p" "$2" | tail -n 1 | sed "s/^'\(.*\)'\$/\1/"
}

# Writes one KEY='value' line; single quotes keep compose from interpolating `$`.
env_line() {
  [[ "$2" != *"'"* && "$2" != *$'\n'* ]] || die "$1 must not contain a single quote or a newline"
  printf "%s='%s'\n" "$1" "$2"
}

# Replaces $2 with the file $1 if they differ. Returns 0 if it changed.
replace_if_changed() {
  if [[ -f "$2" ]] && cmp -s "$1" "$2"; then
    rm -f "$1"
    return 1
  fi
  mv "$1" "$2"
  return 0
}

[[ $EUID -eq 0 ]] || die "run as root (sudo $0)"
[[ -n "${VIBESHIP_HOST:-}" ]] || die "set VIBESHIP_HOST, e.g. VIBESHIP_HOST=vibeship.hiranyey.dev"
[[ "$VIBESHIP_HOST" =~ ^[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] || die "VIBESHIP_HOST must be a lowercase hostname"
[[ "$STACK_ROOT" == /* ]] || die "STACK_ROOT must be an absolute path"

ENV_FILE="$STACK_ROOT/vibeship/.env"
BASE_DOMAIN="${BASE_DOMAIN:-$(env_get BASE_DOMAIN "$ENV_FILE")}"
BASE_DOMAIN="${BASE_DOMAIN:-${VIBESHIP_HOST#*.}}"
ADMIN_EMAILS="${ADMIN_EMAILS:-$(env_get ADMIN_EMAILS "$ENV_FILE")}"
OIDC_ISSUER="${OIDC_ISSUER:-$(env_get OIDC_ISSUER "$ENV_FILE")}"
OIDC_CLIENT_ID="${OIDC_CLIENT_ID:-$(env_get OIDC_CLIENT_ID "$ENV_FILE")}"
OIDC_CLIENT_SECRET="${OIDC_CLIENT_SECRET:-$(env_get OIDC_CLIENT_SECRET "$ENV_FILE")}"
[[ -n "$ADMIN_EMAILS" ]] || die "set ADMIN_EMAILS to the email(s) allowed to log in; anyone the identity provider lets in would otherwise be admin"
[[ "$VIBESHIP_HOST" == *".$BASE_DOMAIN" ]] || die "VIBESHIP_HOST ($VIBESHIP_HOST) must be under BASE_DOMAIN ($BASE_DOMAIN) for the origin certificate to cover it"
if [[ -z "$OIDC_ISSUER" || -z "$OIDC_CLIENT_ID" || -z "$OIDC_CLIENT_SECRET" ]]; then
  [[ -z "$OIDC_ISSUER$OIDC_CLIENT_ID$OIDC_CLIENT_SECRET" ]] || die "set all of OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET, or none"
fi
if [[ -n "${ORIGIN_CERT:-}" || -n "${ORIGIN_KEY:-}" ]]; then
  [[ -f "${ORIGIN_CERT:-}" && -f "${ORIGIN_KEY:-}" ]] || die "ORIGIN_CERT and ORIGIN_KEY must both be readable files"
fi

# 1. Packages: Docker Engine with the compose plugin, unattended security updates, ufw.

if [[ "${SKIP_PACKAGES:-}" != 1 ]]; then
  log "Installing packages"
  # shellcheck source=/dev/null
  . /etc/os-release
  [[ "${ID:-}" == debian ]] || die "this script supports Debian; found ${PRETTY_NAME:-unknown}"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  apt-get install -y -q ca-certificates curl gnupg openssl ufw unattended-upgrades apt-listchanges

  if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
    note "Adding Docker's apt repository"
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: ${VERSION_CODENAME}
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
    apt-get update -q
    apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    note "Docker is already installed: $(docker --version)"
  fi

  # Rotate container logs, including every project's. Left alone if it exists.
  if [[ ! -f /etc/docker/daemon.json ]]; then
    note "Limiting container logs to 5 x 10 MB"
    install -d -m 755 /etc/docker
    printf '{\n  "log-driver": "json-file",\n  "log-opts": { "max-size": "10m", "max-file": "5" }\n}\n' > /etc/docker/daemon.json
    systemctl restart docker
  fi
  systemctl enable --now docker >/dev/null

  # Debian's default unattended-upgrades config installs security updates only.
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
  systemctl enable --now unattended-upgrades >/dev/null
  note "Unattended security updates are on"
fi

command -v docker >/dev/null || die "docker is not installed"
docker info >/dev/null 2>&1 || die "the Docker daemon is not running"

# 2. Networks and folders.

log "Networks and folders"
docker network inspect web >/dev/null 2>&1 || { docker network create web >/dev/null; note "Created network web"; }
if docker network inspect caddy-admin >/dev/null 2>&1; then
  subnet="$(docker network inspect caddy-admin --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}')"
  internal="$(docker network inspect caddy-admin --format '{{.Internal}}')"
  [[ "$subnet" == "$ADMIN_SUBNET" && "$internal" == true ]] \
    || die "network caddy-admin exists but is not internal on $ADMIN_SUBNET (found $subnet, internal=$internal)"
else
  docker network create --internal --subnet "$ADMIN_SUBNET" caddy-admin >/dev/null
  note "Created internal network caddy-admin"
fi
install -d -m 755 "$STACK_ROOT" "$STACK_ROOT/caddy"
install -d -m 700 "$STACK_ROOT/caddy/certs" "$STACK_ROOT/vibeship" "$STACK_ROOT/vibeship/data"
note "$STACK_ROOT/{caddy,vibeship} are ready"

# 3. The Vibeship image.

if [[ -z "${VIBESHIP_IMAGE:-}" ]]; then
  log "Building Vibeship from $REPO"
  VIBESHIP_IMAGE=vibeship:local
  docker build --target prod -t "$VIBESHIP_IMAGE" "$REPO"
else
  log "Using image $VIBESHIP_IMAGE"
  docker image inspect "$VIBESHIP_IMAGE" >/dev/null 2>&1 || docker pull "$VIBESHIP_IMAGE"
fi
run_vibeship() { docker run --rm --network none "$VIBESHIP_IMAGE" "$@"; }

# 4. Vibeship's .env: the master key is generated once and never replaced.

log "Vibeship settings"
current_key="$(env_get MASTER_KEY "$ENV_FILE")"
if [[ -n "$current_key" ]]; then
  [[ -z "${MASTER_KEY:-}" || "$MASTER_KEY" == "$current_key" ]] \
    || die "$ENV_FILE already has a different MASTER_KEY; refusing to replace it (the database's secrets would become unreadable)"
  MASTER_KEY="$current_key"
elif [[ -n "${MASTER_KEY:-}" ]]; then
  note "Using the MASTER_KEY passed in"
else
  MASTER_KEY="$(run_vibeship node src/crypto/master-key.ts)"
  note "Generated a new MASTER_KEY. Back up $ENV_FILE: without the key, stored secrets are lost."
fi
[[ -n "$OIDC_ISSUER" ]] || note "OIDC is not set: browser login is off until you add it (API tokens still work)"

tmp="$(mktemp "$STACK_ROOT/vibeship/.env.XXXXXX")"
chmod 600 "$tmp"
{
  echo "# Written by scripts/bootstrap.sh; re-run it to change these."
  env_line NODE_ENV production
  env_line PORT 3000
  env_line PUBLIC_URL "https://$VIBESHIP_HOST"
  env_line BASE_DOMAIN "$BASE_DOMAIN"
  env_line TLS_MODE origin-cert
  env_line STACK_ROOT "$STACK_ROOT"
  env_line CADDY_ADMIN_URL http://caddy-api:2019
  env_line MASTER_KEY "$MASTER_KEY"
  env_line ADMIN_EMAILS "$ADMIN_EMAILS"
  env_line OIDC_ISSUER "$OIDC_ISSUER"
  env_line OIDC_CLIENT_ID "$OIDC_CLIENT_ID"
  env_line OIDC_CLIENT_SECRET "$OIDC_CLIENT_SECRET"
  env_line VIBESHIP_IMAGE "$VIBESHIP_IMAGE"
} > "$tmp"
if replace_if_changed "$tmp" "$ENV_FILE"; then note "Wrote $ENV_FILE (mode 600)"; else note "$ENV_FILE is up to date"; fi
install -m 644 "$REPO/deploy/vibeship/compose.yaml" "$STACK_ROOT/vibeship/compose.yaml"

# 5. Caddy with the Cloudflare origin certificate.

log "Caddy"
CERT="$STACK_ROOT/caddy/certs/origin.pem"
KEY="$STACK_ROOT/caddy/certs/origin.key"

# Checks a certificate and key pair; prints the names it covers.
check_cert() {
  openssl x509 -in "$1" -noout >/dev/null 2>&1 || die "$1 is not a PEM certificate"
  [[ "$(openssl x509 -in "$1" -noout -pubkey | openssl sha256)" == "$(openssl pkey -in "$2" -pubout 2>/dev/null | openssl sha256)" ]] \
    || die "the origin key does not match the certificate"
  local names
  names="$(openssl x509 -in "$1" -noout -ext subjectAltName 2>/dev/null | tr ',' '\n' | sed -n 's/.*DNS://p' | tr '\n' ' ')"
  [[ " $names" == *" *.$BASE_DOMAIN "* ]] || die "the certificate does not cover *.$BASE_DOMAIN (it has: ${names% })"
  openssl x509 -in "$1" -noout -checkend 0 >/dev/null || die "the certificate has expired"
  printf '%s' "${names% }"
}

caddy_changed=0
if [[ -n "${ORIGIN_CERT:-}" ]]; then
  # Checked before it replaces anything, so a bad pair never reaches Caddy.
  check_cert "$ORIGIN_CERT" "$ORIGIN_KEY" >/dev/null
  if [[ -f "$CERT" && -f "$KEY" ]] && cmp -s "$ORIGIN_CERT" "$CERT" && cmp -s "$ORIGIN_KEY" "$KEY"; then
    note "The origin certificate is already installed"
  else
    install -m 600 "$ORIGIN_CERT" "$CERT.new"
    install -m 600 "$ORIGIN_KEY" "$KEY.new"
    mv "$CERT.new" "$CERT"
    mv "$KEY.new" "$KEY"
    caddy_changed=1
    note "Installed the origin certificate"
  fi
fi
[[ -f "$CERT" && -f "$KEY" ]] || die "no origin certificate yet: pass ORIGIN_CERT and ORIGIN_KEY (Cloudflare > SSL/TLS > Origin Server)"
names="$(check_cert "$CERT" "$KEY")"
openssl x509 -in "$CERT" -noout -checkend $((30 * 86400)) >/dev/null || note "Warning: the origin certificate expires within 30 days"
note "Certificate: $names, $(openssl x509 -in "$CERT" -noout -enddate | sed 's/notAfter=/valid until /')"

tmp="$(mktemp "$STACK_ROOT/caddy/caddy.json.XXXXXX")"
run_vibeship node src/caddy/base-config.ts --host "$VIBESHIP_HOST" --tls origin-cert \
  --cert /etc/caddy/certs/origin.pem --key /etc/caddy/certs/origin.key > "$tmp"
chmod 644 "$tmp"
replace_if_changed "$tmp" "$STACK_ROOT/caddy/caddy.json" && caddy_changed=1
install -m 644 "$REPO/deploy/caddy/compose.yaml" "$STACK_ROOT/caddy/compose.yaml"

# 6. Start, or update, both.

log "Starting Caddy and Vibeship"
caddy_running="$(docker compose -f "$STACK_ROOT/caddy/compose.yaml" ps -q --status running caddy 2>/dev/null || true)"
docker compose -f "$STACK_ROOT/caddy/compose.yaml" up -d --quiet-pull
if [[ -n "$caddy_running" && $caddy_changed == 1 ]]; then
  # Caddy reads both at startup. A reload would drop the project routes
  # Vibeship added; its route sync puts them back either way.
  docker compose -f "$STACK_ROOT/caddy/compose.yaml" restart caddy
  note "Caddy's config or certificate changed; restarted it"
fi
docker compose -f "$STACK_ROOT/vibeship/compose.yaml" up -d --quiet-pull

note "Waiting for Vibeship to report healthy"
container="$(docker compose -f "$STACK_ROOT/vibeship/compose.yaml" ps -q vibeship)"
for _ in $(seq 1 60); do
  health="$(docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || echo unknown)"
  [[ "$health" == healthy ]] && break
  sleep 2
done
if [[ "$health" != healthy ]]; then
  docker compose -f "$STACK_ROOT/vibeship/compose.yaml" logs --tail 40 vibeship >&2 || true
  die "Vibeship is $health after 2 minutes; its logs are above"
fi
note "Vibeship is healthy"

# 7. Firewall: only SSH and HTTPS in. Docker publishes Caddy's 443 through its
# own iptables chains, which bypass ufw's INPUT rules, so the Cloudflare-only
# restriction also goes into DOCKER-USER.

if [[ "${SKIP_FIREWALL:-}" != 1 ]]; then
  log "Firewall"
  command -v ufw >/dev/null || die "ufw is not installed"
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw allow "$SSH_PORT/tcp" comment ssh >/dev/null

  ext_if="$(ip -o route show default | awk '{print $5; exit}')"
  [[ -n "$ext_if" ]] || die "could not find the default network interface"
  for family in 4 6; do
    rules=/etc/ufw/after.rules
    [[ $family == 6 ]] && rules=/etc/ufw/after6.rules
    # Drop the block from an earlier run, then add the current one.
    sed -i '/^# BEGIN vibeship/,/^# END vibeship/d' "$rules"
    if [[ "${CLOUDFLARE_ONLY:-}" == 1 ]]; then
      ranges="$(curl -fsS "https://www.cloudflare.com/ips-v$family")" || die "could not fetch Cloudflare's IPv$family ranges"
      {
        echo "# BEGIN vibeship: only Cloudflare reaches the published port 443"
        echo "*filter"
        echo ":DOCKER-USER - [0:0]"
        echo "-A DOCKER-USER -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN"
        for r in $ranges; do echo "-A DOCKER-USER -i $ext_if -p tcp --dport 443 -s $r -j RETURN"; done
        echo "-A DOCKER-USER -i $ext_if -p tcp --dport 443 -j DROP"
        echo "-A DOCKER-USER -j RETURN"
        echo "COMMIT"
        echo "# END vibeship"
      } >> "$rules"
      for r in $ranges; do ufw allow proto tcp from "$r" to any port 443 comment cloudflare >/dev/null; done
    fi
  done
  if [[ "${CLOUDFLARE_ONLY:-}" == 1 ]]; then
    ufw delete allow 443/tcp >/dev/null 2>&1 || true
    note "443 accepts Cloudflare's ranges only"
  else
    ufw allow 443/tcp comment https >/dev/null
  fi
  ufw --force enable >/dev/null
  ufw reload >/dev/null
  ufw status verbose | sed 's/^/    /'
fi

# Done.

log "Vibeship is running at https://$VIBESHIP_HOST"
cat <<EOF
    Next:
    - Cloudflare: a proxied DNS record for *.$BASE_DOMAIN (and $VIBESHIP_HOST)
      pointing at this server, and SSL/TLS mode "Full (strict)".
    - Clerk: allow the redirect URL https://$VIBESHIP_HOST/auth/callback.
    - A first API token, for CI or MCP:
        docker compose -f $STACK_ROOT/vibeship/compose.yaml exec vibeship node src/token-cli.ts <name> <read|deploy|admin>
    - Keep a copy of $ENV_FILE (it holds MASTER_KEY) somewhere safe.
EOF
