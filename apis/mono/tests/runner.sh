#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
COMPOSE_DIR="${MONO_DIR}/deploy"

TEST_NAME="${1:?Usage: $0 <test-name>}"
TEST_SCRIPT="${SCRIPT_DIR}/${TEST_NAME}.js"

if [ ! -f "$TEST_SCRIPT" ]; then
    echo "Error: no test script at ${TEST_SCRIPT}"
    exit 1
fi

cd "$COMPOSE_DIR"

ENV_FILE="${ENV_FILE:-${MONO_DIR}/.env}"
LISTEN_PORT="${LISTEN_PORT:-3000}"
SERVER_URL="http://localhost:${LISTEN_PORT}"

if [ ! -f "$ENV_FILE" ]; then
    echo "Error: $ENV_FILE not found."
    exit 1
fi

cleanup() {
    echo ""
    echo "Tearing down..."
    docker compose --env-file "$ENV_FILE" down -v -t 0
}
trap cleanup EXIT

echo "Building and deploying 4-replica mono stack..."
# docker hub imposes an unauthenticated pull rate limit (100/6h per IP),
# and GitHub Actions runners share IPs. first up may fail pulling
# nginx:alpine. retry with backoff; image ends up cached after a success.
for attempt in 1 2 3 4 5; do
    if REPLICAS="${REPLICAS:-4}" docker compose --env-file "$ENV_FILE" up -d --build; then
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

echo ""
docker compose --env-file "$ENV_FILE" ps

echo ""
echo "=== ${TEST_NAME} ==="
if SERVER_URL="${SERVER_URL}" node "${TEST_SCRIPT}"; then
    echo "[PASS] ${TEST_NAME}"
    exit 0
fi

echo "[FAIL] ${TEST_NAME}"
echo ""
echo "=== container diagnostics ==="
docker compose --env-file "$ENV_FILE" ps -a || true
for cid in $(docker compose --env-file "$ENV_FILE" ps -aq 2>/dev/null); do
    cname=$(docker inspect --format '{{.Name}} ({{.State.Status}})' "$cid" 2>/dev/null || echo "$cid")
    echo "--- logs ${cname} (last 200) ---"
    docker logs --tail 200 "$cid" 2>&1 || true
    echo ""
done
exit 1
