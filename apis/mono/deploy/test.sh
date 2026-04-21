#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE="${ENV_FILE:-../.env}"

if [ ! -f "$ENV_FILE" ]; then
    echo "Error: $ENV_FILE not found."
    exit 1
fi

cleanup() {
    docker compose --env-file "$ENV_FILE" down -v -t 0
}
trap cleanup EXIT

# npm install in the Dockerfile and image pulls against docker hub/npm
# registry can flake on shared-IP CI runners (ECONNRESET, 100/6h docker
# hub limit). retry with backoff; successful layers are cached locally.
for attempt in 1 2 3 4 5; do
    if docker compose --env-file "$ENV_FILE" up -d --build; then
        break
    fi
    echo "compose up failed (attempt $attempt); sleeping before retry..."
    docker compose --env-file "$ENV_FILE" down -v -t 0 || true
    sleep $((attempt * 10))
    if [ "$attempt" = 5 ]; then
        echo "compose up failed after 5 attempts"
        exit 1
    fi
done
docker wait api-setup && docker rm api-setup

bash "${APP_DIR}/specs/run.sh"
