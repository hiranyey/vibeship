#!/usr/bin/env bash
# Runs the local dev stack. With no arguments it builds and starts it;
# otherwise the arguments go to `docker compose` (e.g. `scripts/dev.sh down`).
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  echo "Created .env from .env.example"
fi

# Fill in an empty or missing MASTER_KEY so local runs need no setup.
if ! grep -qE '^MASTER_KEY=.+' .env; then
  key="$(node src/crypto/master-key.ts)"
  if grep -q '^MASTER_KEY=' .env; then
    sed -i.bak "s#^MASTER_KEY=.*#MASTER_KEY=${key}#" .env && rm .env.bak
  else
    printf '\nMASTER_KEY=%s\n' "$key" >> .env
  fi
  echo "Generated MASTER_KEY in .env"
fi

export STACK_ROOT="$PWD/.dev/stack"
mkdir -p "$STACK_ROOT"

docker network inspect web >/dev/null 2>&1 || docker network create web >/dev/null
docker network inspect caddy-admin >/dev/null 2>&1 \
  || docker network create --internal --subnet 172.31.250.0/24 caddy-admin >/dev/null

if [[ $# -eq 0 ]]; then
  set -- up --build
fi
exec docker compose -f compose.dev.yaml "$@"
