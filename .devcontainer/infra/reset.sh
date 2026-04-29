#!/bin/bash
set -Eeuo pipefail
cd "$(dirname "$0")"

# Diagnostic snapshot — surfaces resource pressure (OOM/disk) when reset.sh
# fails abruptly. The 2026-04-28 Test Stability bootup-mono regression hit
# `exit code: undefined` mid-pull, suggesting signal kill from runner OS.
echo "=== reset.sh start ==="
echo "[mem]"; free -m || true
echo "[disk]"; df -h / /tmp 2>/dev/null || true

docker rm -f $(docker ps -aq) 2>/dev/null || true
docker volume prune -af

# docker hub anonymous pull rate limit (100/6h per IP) plus shared runner IPs
# can flake compose up on first pull. retry pattern matches
# apis/mono/deploy/test.sh / apis/msa/deploy/test.sh.
compose_up_with_retry() {
    local label="$1"
    for attempt in 1 2 3 4 5; do
        if docker compose up -d; then
            return 0
        fi
        echo "[reset.sh] $label compose up failed (attempt $attempt); sleeping..."
        docker compose down -v -t 0 || true
        sleep $((attempt * 10))
    done
    echo "[reset.sh] $label compose up failed after 5 attempts"
    return 1
}

compose_up_with_retry "infra"
cd msa
compose_up_with_retry "msa-infra"

docker wait infra-setup msa-setup
docker rm infra-setup msa-setup
echo "=== reset.sh done ==="
