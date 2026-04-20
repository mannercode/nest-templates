#!/usr/bin/env bash
set -Eeuo pipefail

scope="$1"
cd .devcontainer/infra

docker rm -f $(docker ps -aq) 2>/dev/null || true
docker volume prune -af

if [ "$scope" = "mono" ]; then
    docker compose up -d
    docker wait infra-setup
    docker rm infra-setup
elif [ "$scope" = "msa" ]; then
    docker compose up -d
    cd msa
    docker compose up -d
    docker wait infra-setup msa-setup
    docker rm infra-setup msa-setup
fi

cd /workspaces/nest-seed
npm test -w "apis/$scope" -- --coverageThreshold='{}'
