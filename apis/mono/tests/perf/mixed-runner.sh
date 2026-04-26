#!/usr/bin/env bash
# Mixed read/write workload matrix for mono.
#
# Each case starts theater-read and theater-write processes at (nearly) the same
# moment so they share the measurement window. Both use the same LABEL so the
# output JSONs can be paired after the fact.
#
# Prereq: mono stack up (REPLICAS=8 recommended), theaters seeded (~50K+).
#
# Usage: bash apis/mono/tests/perf/mixed-runner.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HARNESS="${SCRIPT_DIR}/harness.js"

DURATION_MS="${DURATION_MS:-30000}"
WARMUP_MS="${WARMUP_MS:-3000}"

run_case() {
    local label="$1"
    local read_c="$2"
    local write_c="$3"

    echo
    echo "=========================================================="
    echo "CASE ${label}  read_c=${read_c}  write_c=${write_c}"
    echo "=========================================================="

    local pids=()

    if [ "$read_c" -gt 0 ]; then
        SCENARIO=theater-read CONCURRENCY="$read_c" \
            DURATION_MS="$DURATION_MS" WARMUP_MS="$WARMUP_MS" \
            LABEL="$label" node "$HARNESS" &
        pids+=("$!")
    fi
    if [ "$write_c" -gt 0 ]; then
        SCENARIO=theater-write CONCURRENCY="$write_c" \
            DURATION_MS="$DURATION_MS" WARMUP_MS="$WARMUP_MS" \
            LABEL="$label" node "$HARNESS" &
        pids+=("$!")
    fi

    for pid in "${pids[@]}"; do
        wait "$pid"
    done

    echo
    echo "--- settle 10s ---"
    sleep 10
}

run_case iso-r200       200 0
run_case iso-w100       0   100
run_case mixed-r100w50  100 50
run_case mixed-r100w100 100 100
run_case mixed-r200w50  200 50
run_case mixed-r200w100 200 100

echo
echo "=========================================================="
echo "DONE. results in _output/perf/<scenario>-<ts>-<label>.json"
echo "=========================================================="
