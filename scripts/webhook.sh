#!/usr/bin/env bash
# Sends a deploy webhook by hand, the way the GitHub Actions workflow does.
#
#   scripts/webhook.sh <webhook-url> <image>
#   scripts/webhook.sh http://vibeship.localhost:8080/hooks/deploy/abc… localhost:5050/fixtures/app:hello
#
# <image> is repository:tag; its digest is looked up in the registry (plain
# HTTP for localhost, HTTPS otherwise). Pass repository@sha256:… to send a
# digest as is.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <webhook-url> <image:tag | image@sha256:…>" >&2
  exit 2
fi
url=$1 image=$2

if [[ $image == *@sha256:* ]]; then
  repository=${image%@*}
  digest=${image#*@}
else
  last=${image##*/}
  if [[ $last == *:* ]]; then repository=${image%:*} tag=${last##*:}; else repository=$image tag=latest; fi
  host=${repository%%/*}
  name=${repository#*/}
  if [[ $host == localhost* || $host == 127.0.0.1* ]]; then scheme=http; else scheme=https; fi
  # The digest the registry serves for the tag, the same one `docker pull` resolves to.
  digest=$(curl -fsS -I \
    -H 'Accept: application/vnd.oci.image.index.v1+json' \
    -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
    -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
    -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
    "$scheme://$host/v2/$name/manifests/$tag" \
    | tr -d '\r' | awk 'tolower($1) == "docker-content-digest:" { print $2 }')
  if [[ -z $digest ]]; then
    echo "Could not find the digest of $image in the registry" >&2
    exit 1
  fi
fi

echo "Deploying $repository@$digest" >&2
curl -fsS -X POST -H 'Content-Type: application/json' \
  --data "{\"digest\": \"$digest\", \"image\": \"$repository\"}" \
  "$url"
echo
