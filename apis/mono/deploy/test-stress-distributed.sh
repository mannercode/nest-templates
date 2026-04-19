#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE="${ENV_FILE:-../.env}"
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
REPLICAS="${REPLICAS:-4}" docker compose --env-file "$ENV_FILE" up -d --build
docker wait api-setup && docker rm api-setup

echo ""
docker compose --env-file "$ENV_FILE" ps

FAILED=0

run_test() {
    local name=$1
    local script=$2

    echo ""
    echo "=== ${name} ==="
    if SERVER_URL="${SERVER_URL}" node "${SCRIPT_DIR}/stress/${script}"; then
        echo "[PASS] ${name}"
    else
        echo "[FAIL] ${name}"
        FAILED=1
    fi
}

run_test "cross-replica SSE fan-out" "cross-replica-sse.js"
run_test "cross-replica customer email race" "customers-race.js"

if [[ "${FAILED}" -ne 0 ]]; then
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
fi

echo ""
echo "All distributed stress tests passed."
