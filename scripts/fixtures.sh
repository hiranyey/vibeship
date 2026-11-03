#!/usr/bin/env bash
# Builds the fixture images, pushes them to the local registry as tags of
# localhost:5050/fixtures/app, and writes their digests to .dev/fixtures.json.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO=localhost:5050/fixtures/app
out=.dev/fixtures.json
mkdir -p .dev

build() { # tag mode version
  docker build -q -t "$REPO:$1" --build-arg "MODE=$2" --build-arg "VERSION=$3" examples/fixture >/dev/null
  docker push -q "$REPO:$1" >/dev/null
  docker image inspect --format '{{index .RepoDigests 0}}' "$REPO:$1" | sed 's/.*@//'
}

{
  echo '{'
  echo "  \"repository\": \"$REPO\","
  echo "  \"hello\": \"$(build hello hello v1)\","
  echo "  \"hello-v2\": \"$(build hello-v2 hello v2)\","
  echo "  \"crash\": \"$(build crash crash v1)\","
  echo "  \"unhealthy\": \"$(build unhealthy unhealthy v1)\","
  echo "  \"slow\": \"$(build slow slow v1)\","
  echo "  \"probe\": \"$(build probe probe v1)\""
  echo '}'
} > "$out.tmp"
mv "$out.tmp" "$out"
cat "$out"
