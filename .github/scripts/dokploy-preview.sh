#!/usr/bin/env bash
# Creates, deploys and removes one pull request's preview of the site in
# Dokploy, through its REST bridge (`<url>/api/<router>.<procedure>`, queries
# as GET with one parameter per field, mutations as POST with a JSON body).
#
# The preview is a Docker-image application, named `pr-<number>`, in the
# environment DOKPLOY_PREVIEW_ENVIRONMENT_ID. Dokploy only pulls the image CI
# built and scanned; it never builds pull-request code. The API key belongs to
# a member who can create and delete services only in the preview project.
#
# Usage: dokploy-preview.sh deploy <pr-number> <image>
#        dokploy-preview.sh destroy <pr-number>
#
# Environment:
#   DOKPLOY_URL                     e.g. https://dokploy.example.com
#   DOKPLOY_API_KEY                 the preview member's API key
#   DOKPLOY_PREVIEW_ENVIRONMENT_ID  the environment previews live in
#   PREVIEW_DOMAIN                  wildcard parent, e.g. static.example.com
#   GHCR_PULL_USER, GHCR_PULL_TOKEN optional, for a private image
#
# `deploy` prints the preview URL on stdout.
set -euo pipefail

: "${DOKPLOY_URL:?}" "${DOKPLOY_API_KEY:?}" "${DOKPLOY_PREVIEW_ENVIRONMENT_ID:?}" "${PREVIEW_DOMAIN:?}"

ACTION="${1:?deploy or destroy}"
PR="${2:?pull request number}"
case "$PR" in *[!0-9]*) echo "pull request number must be numeric" >&2; exit 2 ;; esac
NAME="pr-$PR"
HOST="routecraft-$NAME.$PREVIEW_DOMAIN"
# The port the site image listens on (EXPOSE in apps/routecraft.dev/Dockerfile).
PORT=3000

api_get() {
  local proc="$1"; shift
  curl --fail-with-body --silent --show-error --get \
    -H "x-api-key: $DOKPLOY_API_KEY" "$@" "$DOKPLOY_URL/api/$proc"
}

api_post() {
  curl --fail-with-body --silent --show-error -X POST \
    -H "x-api-key: $DOKPLOY_API_KEY" -H "Content-Type: application/json" \
    --data "$2" "$DOKPLOY_URL/api/$1"
}

# Search matches by substring (pr-1 also finds pr-12), so the name is compared
# exactly here.
find_app() {
  api_get application.search \
    --data-urlencode "environmentId=$DOKPLOY_PREVIEW_ENVIRONMENT_ID" \
    --data-urlencode "name=$NAME" --data-urlencode "limit=100" |
    jq -r --arg name "$NAME" '[.items[] | select(.name == $name)][0].applicationId // empty'
}

case "$ACTION" in
  deploy)
    IMAGE="${3:?image reference}"
    APP_ID="$(find_app)"
    if [ -z "$APP_ID" ]; then
      APP_ID="$(api_post application.create "$(jq -nc \
        --arg name "$NAME" --arg env "$DOKPLOY_PREVIEW_ENVIRONMENT_ID" \
        '{name: $name, appName: ("routecraft-" + $name), environmentId: $env,
          description: "Pull request preview, managed by site-preview.yml"}')" |
        jq -r '.applicationId')"
      api_post domain.create "$(jq -nc \
        --arg host "$HOST" --arg app "$APP_ID" --argjson port "$PORT" \
        '{host: $host, applicationId: $app, domainType: "application",
          port: $port, https: true, certificateType: "letsencrypt",
          path: "/", customCertResolver: ""}')" >/dev/null
    fi
    # Every key is required by the schema; empty credentials mean a public image.
    api_post application.saveDockerProvider "$(jq -nc \
      --arg app "$APP_ID" --arg image "$IMAGE" \
      --arg user "${GHCR_PULL_USER:-}" --arg pass "${GHCR_PULL_TOKEN:-}" \
      '{applicationId: $app, dockerImage: $image,
        registryUrl: (if $user != "" then "ghcr.io" else "" end),
        username: $user, password: $pass}')" >/dev/null
    api_post application.deploy "$(jq -nc --arg app "$APP_ID" --arg image "$IMAGE" \
      '{applicationId: $app, title: ("Deploy " + $image)}')" >/dev/null
    echo "https://$HOST"
    ;;
  destroy)
    APP_ID="$(find_app)"
    if [ -n "$APP_ID" ]; then
      api_post application.delete "$(jq -nc --arg app "$APP_ID" '{applicationId: $app}')" >/dev/null
      echo "Removed the preview $NAME" >&2
    else
      echo "No preview named $NAME to remove" >&2
    fi
    ;;
  *)
    echo "unknown action: $ACTION" >&2
    exit 2
    ;;
esac
