#!/usr/bin/env bash
set -Eeuo pipefail

scope="$1"
cd .devcontainer/infra

docker rm -f $(docker ps -aq) 2>/dev/null || true
docker volume prune -af

# docker hub's unauthenticated 100/6h pull limit is shared across actions
# runners. a first `up` can fail pulling mongo/redis/minio/temporal/etc.
# retry with backoff; images stay cached after a successful pull.
compose_up() {
    for attempt in 1 2 3 4 5; do
        if docker compose up -d; then
            return 0
        fi
        echo "compose up failed (attempt $attempt); sleeping before retry..."
        docker compose down -v -t 0 || true
        sleep $((attempt * 10))
    done
    echo "compose up failed after 5 attempts"
    return 1
}

if [ "$scope" = "mono" ]; then
    compose_up
    docker wait infra-setup
    docker rm infra-setup
elif [ "$scope" = "msa" ]; then
    compose_up
    cd msa
    compose_up
    docker wait infra-setup msa-setup
    docker rm infra-setup msa-setup
fi

cd /workspaces/nest-seed
npm test -w "apis/$scope" -- --coverageThreshold='{}'
