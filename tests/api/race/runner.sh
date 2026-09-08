#!/bin/bash
set -Eeuo pipefail
cd -- "$(dirname -- "$0")"

# API 테스트 스택 기동, admin 인증, 단일 race 시나리오 실행과 정리를 한 번에 수행한다.
# 사용: pnpm run race <scenario-name>
#  예) pnpm run race purchase-double-spend

: "${WORKSPACE_ROOT:?}"

# infra compose와 docker network를 공유하므로 docker compose가 infra 컨테이너를 orphan으로 표시한다.
# 의미적으로 별개의 묶음이라 경고만 끈다.
export COMPOSE_IGNORE_ORPHANS=True

compose=(docker compose -f ../compose.yml)

list_scenarios() {
    echo "Scenarios:"
    for f in ./*.js; do
        name="$(basename "$f" .js)"
        [ "$name" = "race-common" ] && continue
        echo "  $name"
    done
}

TEST_NAME="${1:-}"
if [ -z "${TEST_NAME}" ]; then
    echo "Usage: pnpm run race <scenario>"
    list_scenarios
    exit 0
fi
TEST_SCRIPT="${TEST_NAME}.js"

if [ ! -f "${TEST_SCRIPT}" ]; then
    echo "Error: no test script at ${TEST_SCRIPT}"
    list_scenarios
    exit 1
fi

set -a
# shellcheck source=../../../.env.infra
. "${WORKSPACE_ROOT}/.env.infra"
set +a

SERVER_URL="http://nginx"
cleanup() {
    echo ""
    echo "Tearing down..."
    "${compose[@]}" down -v -t 0
}
trap cleanup EXIT

dump_diagnostics() {
    local service cid cname

    echo ""
    echo "=== container diagnostics ==="
    date --utc --iso-8601=seconds
    "${compose[@]}" ps -a || true

    timeout --kill-after=2s 10s "${compose[@]}" stats --all --no-stream --format json \
        || echo "[diagnostics] container resource collection failed" >&2

    for cid in $("${compose[@]}" ps -aq 2>/dev/null); do
        cname=$(docker inspect --format '{{.Name}} ({{.State.Status}})' "${cid}" 2>/dev/null || echo "${cid}")
        docker inspect --format 'name={{.Name}} state={{json .State}} restarts={{.RestartCount}}' "${cid}" \
            || echo "[diagnostics] container state collection failed: ${cid}" >&2
        echo "--- logs ${cname} (last 200) ---"
        docker logs --tail 200 "${cid}" 2>&1 || true
        echo ""
    done

    # 복제 지연은 ping health만으로 알 수 없으므로 각 노드에 직접 상태를 묻는다.
    # 상태 조회가 남기는 로그에 실패 직전 기록이 밀리지 않도록 기존 로그를 먼저 수집한다.
    for service in mongo1 mongo2 mongo3; do
        echo "--- MongoDB diagnostics: ${service} ---"
        timeout --kill-after=2s 10s docker compose -f "${WORKSPACE_ROOT}/infra/compose.yml" \
            exec -T "${service}" mongosh \
            'mongodb://localhost:27017/?directConnection=true&serverSelectionTimeoutMS=2000&connectTimeoutMS=2000&socketTimeoutMS=5000' \
            --quiet --eval '
                print(EJSON.stringify({ replicaSet: db.adminCommand({ replSetGetStatus: 1 }) }))
                const s = db.serverStatus()
                print(EJSON.stringify({ server: {
                    host: s.host,
                    localTime: s.localTime,
                    uptime: s.uptime,
                    connections: s.connections,
                    mem: s.mem,
                    globalLock: s.globalLock,
                    flowControl: s.flowControl,
                    repl: s.metrics.repl,
                    cache: {
                        bytes: s.wiredTiger.cache["bytes currently in the cache"],
                        maxBytes: s.wiredTiger.cache["maximum bytes configured"],
                        dirtyBytes: s.wiredTiger.cache["tracked dirty bytes in the cache"],
                        timeouts: s.wiredTiger.cache["operations timed out waiting for space in cache"]
                    },
                    journal: {
                        syncs: s.wiredTiger.log["log sync operations"],
                        syncMicros: s.wiredTiger.log["log sync time duration (usecs)"]
                    }
                } }))
            ' </dev/null || echo "[diagnostics] MongoDB state collection failed: ${service}" >&2
    done
}

bring_up_stack() {
    echo "Building 4-replica api test stack..."

    if ! "${compose[@]}" up -d --build --wait; then
        echo "[FAIL] compose up failed before ${TEST_NAME} could start"
        dump_diagnostics
        exit 1
    fi

    echo ""
    "${compose[@]}" ps

    # Restate는 실행 endpoint를 자동 발견하지 않는다. AtoZ/Stability는 시작 전에
    # infra를 reset하므로 최초 등록되고, 같은 코드 반복은 기존 등록을 그대로 쓴다.
    "${compose[@]}" run --rm --no-deps restate-register
}

# admin은 infra/reset.sh가 만든 고정 개발 fixture로 로그인한다.
# 콘텐츠 endpoint(POST /movies, /theaters, /showtime-creation/*)는 admin token만 통과한다.
# admin이 없으면 개발 상태가 준비되지 않은 것이므로 로그인 실패를 그대로 보고한다.
login_admin() {
    local login_res
    login_res=$(curl -sS -X POST "${SERVER_URL}/admins/login" \
        -H 'Content-Type: application/json' \
        -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}")
    ADMIN_ACCESS_TOKEN=$(echo "${login_res}" | jq -r '.accessToken // empty')
    if [ -z "${ADMIN_ACCESS_TOKEN}" ]; then
        echo "Error: admin login failed: ${login_res}"
        dump_diagnostics
        exit 1
    fi
    export ADMIN_ACCESS_TOKEN
}

run_scenario() {
    echo ""
    echo "=== ${TEST_NAME} ==="
    if SERVER_URL="${SERVER_URL}" node --test --test-reporter=spec "${TEST_SCRIPT}"; then
        echo "[PASS] ${TEST_NAME}"
        return 0
    fi

    echo "[FAIL] ${TEST_NAME}"
    dump_diagnostics
    return 1
}

bring_up_stack
login_admin
run_scenario
