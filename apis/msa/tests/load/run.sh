#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
COMPOSE_DIR="${APP_DIR}/deploy"
cd "$COMPOSE_DIR"

ENV_FILE="${ENV_FILE:-${APP_DIR}/.env}"

if [ ! -f "$ENV_FILE" ]; then
    echo "Error: $ENV_FILE not found."
    exit 1
fi

CLIENTS=${CLIENTS:-10}
ROUNDS=${ROUNDS:-20}
LISTEN_PORT=${LISTEN_PORT:-3100}
SERVER_URL="http://localhost:${LISTEN_PORT}"
API_SPEC_DIR="${APP_DIR}/specs"
LOG_DIR="${SCRIPT_DIR}/_output/logs/$(date '+%Y%m%d_%H%M%S')"

RESET='\033[0m'
BOLD='\033[1m'
GREEN='\033[32m'
RED='\033[31m'
CYAN='\033[36m'

cleanup() {
    echo ""
    echo "Tearing down..."
    docker compose --env-file "$ENV_FILE" down -v -t 0
}
trap cleanup EXIT

echo "Cleaning up infra data from previous runs..."
node -e "
const { MongoClient } = require('mongodb');
const Redis = require('ioredis');
(async () => {
    const nodes = [
        process.env.MONGO_HOST1 + ':' + process.env.MONGO_PORT1,
        process.env.MONGO_HOST2 + ':' + process.env.MONGO_PORT2,
        process.env.MONGO_HOST3 + ':' + process.env.MONGO_PORT3,
    ].join(',');
    const mongo = new MongoClient(
        'mongodb://' + process.env.MONGO_USERNAME + ':' + process.env.MONGO_PASSWORD +
        '@' + nodes + '/?replicaSet=' + process.env.MONGO_REPLICA_SET
    );
    await mongo.connect();
    await mongo.db(process.env.MONGO_DATABASE).dropDatabase();
    await mongo.close();

    const redisNodes = [
        { host: process.env.REDIS_HOST1, port: +process.env.REDIS_PORT1 },
        { host: process.env.REDIS_HOST2, port: +process.env.REDIS_PORT2 },
        { host: process.env.REDIS_HOST3, port: +process.env.REDIS_PORT3 },
        { host: process.env.REDIS_HOST4, port: +process.env.REDIS_PORT4 },
        { host: process.env.REDIS_HOST5, port: +process.env.REDIS_PORT5 },
        { host: process.env.REDIS_HOST6, port: +process.env.REDIS_PORT6 },
    ];
    const cluster = new Redis.Cluster(redisNodes);
    const masters = cluster.nodes('master');
    await Promise.all(masters.map(n => n.flushall()));
    await cluster.quit();
})();
"

echo "Building and deploying msa app..."
docker compose --env-file "$ENV_FILE" up -d --build
docker wait api-setup && docker rm api-setup

echo ""
docker compose --env-file "$ENV_FILE" ps

mkdir -p "${LOG_DIR}"

echo ""
echo -e "${BOLD}Stress Test${RESET}"
echo -e "  server  : ${CYAN}${SERVER_URL}${RESET}"
echo -e "  clients : ${CYAN}${CLIENTS}${RESET}"
echo -e "  rounds  : ${CYAN}${ROUNDS}${RESET}"
echo ""

run_client() {
    local client_id=$1
    local round=$2
    local log_file="${LOG_DIR}/client_${client_id}_round_${round}.log"

    SERVER_URL="${SERVER_URL}" bash "${API_SPEC_DIR}/run.sh" >"${log_file}" 2>&1
    return $?
}

TOTAL=0
PASSED=0
FAILED=0
FAILED_LOGS=()

for ((round = 1; round <= ROUNDS; round++)); do
    echo -e "${BOLD}Round ${round}/${ROUNDS}${RESET}"

    pids=()
    for ((client = 1; client <= CLIENTS; client++)); do
        run_client "${client}" "${round}" &
        pids+=($!)
    done

    for i in "${!pids[@]}"; do
        client=$((i + 1))
        TOTAL=$((TOTAL + 1))

        if wait "${pids[$i]}"; then
            PASSED=$((PASSED + 1))
            echo -e "  ${GREEN}[PASS]${RESET} client ${client}"
        else
            FAILED=$((FAILED + 1))
            echo -e "  ${RED}[FAIL]${RESET} client ${client} (see ${LOG_DIR}/client_${client}_round_${round}.log)"
            FAILED_LOGS+=("${LOG_DIR}/client_${client}_round_${round}.log")
        fi
    done

    echo ""
done

echo -e "${BOLD}Results${RESET}"
echo -e "  total  : ${TOTAL}"
echo -e "  passed : ${GREEN}${PASSED}${RESET}"
echo -e "  failed : ${RED}${FAILED}${RESET}"
echo -e "  logs   : ${CYAN}${LOG_DIR}${RESET}"

if [[ "${FAILED}" -gt 0 ]]; then
    echo ""
    for log in "${FAILED_LOGS[@]}"; do
        echo -e "${BOLD}${RED}=== ${log} ===${RESET}"
        cat "${log}"
        echo ""
    done

    exit 1
fi
