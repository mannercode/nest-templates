// Sustained-load perf harness for the mono stack.
//
// Measures throughput + latency percentiles under a fixed concurrency level
// for a chosen scenario. Emits JSON to stdout (last line) and human summary
// to stderr. Designed to be invoked repeatedly across tuning cycles; raw
// results are written to _output/perf/<scenario>-<timestamp>.json.
//
// Env:
//   SERVER_URL     default http://localhost:3000
//   SCENARIO       customer-write | customer-read | mixed    (default: customer-write)
//   CONCURRENCY    number of in-flight requests              (default: 100)
//   DURATION_MS    steady-state duration in ms               (default: 30000)
//   WARMUP_MS      warmup before measurement window          (default: 3000)
//   LABEL          free-form tag stored in the JSON output   (default: '')

const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000'
const SCENARIO = process.env.SCENARIO || 'customer-write'
const CONCURRENCY = Number(process.env.CONCURRENCY || 100)
const DURATION_MS = Number(process.env.DURATION_MS || 30_000)
const WARMUP_MS = Number(process.env.WARMUP_MS || 3_000)
const LABEL = process.env.LABEL || ''
const ACCEPT_GZIP = process.env.ACCEPT_GZIP === '1'

const url = new URL(SERVER_URL)
// keepAlive=true so the harness exercises the nginx keepalive pool. Each
// worker gets its own Agent to avoid socket contention inside ioredis/nginx
// behaviour that we *do* want to see (pool-level queueing), because the TCP
// layer should not be the bottleneck.
function makeAgent() {
    return new http.Agent({ keepAlive: true, maxSockets: 4 })
}

function uniqueEmail(workerId, seq) {
    return `perf.${Date.now()}.${workerId}.${seq}.${Math.random().toString(36).slice(2, 8)}@example.com`
}

function buildRequestFactory(scenario) {
    if (scenario === 'customer-write') {
        return (workerId, seq) => ({
            method: 'POST',
            path: '/customers',
            body: {
                name: `perf-${workerId}-${seq}`,
                email: uniqueEmail(workerId, seq),
                password: 'perfpassword',
                birthDate: '1990-01-01T00:00:00.000Z'
            },
            expectStatus: 201
        })
    }
    if (scenario === 'customer-read') {
        // NOTE: GET /customers requires JWT — this scenario measures auth-reject
        // throughput, not mongo-read throughput. Use theater-read or movie-read
        // for unauthenticated mongo-read measurement.
        return () => ({ method: 'GET', path: '/customers?take=50', body: null, expectStatus: 200 })
    }
    if (scenario === 'theater-write') {
        // POST /theaters has no auth guard; pure mongo write + majority commit.
        // Body is small but non-trivial (nested validation).
        return (workerId, seq) => ({
            method: 'POST',
            path: '/theaters',
            body: {
                name: `perf-theater-${Date.now()}-${workerId}-${seq}-${Math.random().toString(36).slice(2, 8)}`,
                location: { latitude: 37.5, longitude: 127.0 },
                seatmap: {
                    blocks: [
                        {
                            name: 'A',
                            rows: [
                                { name: '1', layout: 'OOOOOOOOOO' },
                                { name: '2', layout: 'OOOOOOOOOO' }
                            ]
                        }
                    ]
                }
            },
            expectStatus: 201
        })
    }
    if (scenario === 'theater-read') {
        // Pagination uses page/size (PaginationDto), not take/skip.
        return () => ({
            method: 'GET',
            path: '/theaters?page=1&size=50',
            body: null,
            expectStatus: 200
        })
    }
    if (scenario === 'theater-read-size1') {
        return () => ({
            method: 'GET',
            path: '/theaters?page=1&size=1',
            body: null,
            expectStatus: 200
        })
    }
    if (scenario === 'theater-read-name-filter') {
        // Prefix 매치가 되는 패턴 (cycle-10 prefix-mode + cycle-12 compound
        // index). 현실적 검색 시나리오 ("사용자가 타이핑해서 좁혀 나감")
        // 에 가까운 좁은 prefix 사용.
        return () => ({
            method: 'GET',
            path: '/theaters?page=1&size=50&name=perf-theater-17769404',
            body: null,
            expectStatus: 200
        })
    }
    if (scenario === 'movie-read') {
        return () => ({
            method: 'GET',
            path: '/movies?page=1&size=50',
            body: null,
            expectStatus: 200
        })
    }
    if (scenario === 'movie-write') {
        // 순수 mongo write (bcrypt 없음). 필터 측정 전 seed 용도.
        return (workerId, seq) => ({
            method: 'POST',
            path: '/movies',
            body: {
                title: `perf-movie-${Date.now()}-${workerId}-${seq}-${Math.random().toString(36).slice(2, 8)}`
            },
            expectStatus: 201
        })
    }
    if (scenario === 'movie-read-title-filter') {
        // movies 도 cycle-12 와 같은 prefix + case-sensitive 패턴 (cycle-15).
        // 좁은 prefix → 매치 0 에 가까워 countDocuments 가 IXSCAN 으로 빠짐.
        return () => ({
            method: 'GET',
            path: '/movies?page=1&size=50&title=perf-movie-17769404',
            body: null,
            expectStatus: 200
        })
    }
    if (scenario === 'health') {
        return () => ({ method: 'GET', path: '/health', body: null, expectStatus: 200 })
    }
    throw new Error(`unknown scenario: ${scenario}`)
}

function doRequest(agent, req) {
    const payload = req.body == null ? null : JSON.stringify(req.body)
    return new Promise((resolve) => {
        const start = process.hrtime.bigint()
        const headers = { accept: 'application/json' }
        if (ACCEPT_GZIP) headers['accept-encoding'] = 'gzip'
        if (payload != null) {
            headers['content-type'] = 'application/json'
            headers['content-length'] = Buffer.byteLength(payload)
        }
        const r = http.request(
            {
                agent,
                hostname: url.hostname,
                port: url.port,
                path: req.path,
                method: req.method,
                headers
            },
            (res) => {
                res.on('data', () => {}) // drain
                res.on('end', () => {
                    const end = process.hrtime.bigint()
                    resolve({
                        status: res.statusCode,
                        replicaId: res.headers['x-replica-id'] || null,
                        latencyNs: Number(end - start)
                    })
                })
                res.on('error', () => {
                    const end = process.hrtime.bigint()
                    resolve({ status: -2, replicaId: null, latencyNs: Number(end - start) })
                })
            }
        )
        r.on('error', () => {
            const end = process.hrtime.bigint()
            resolve({ status: -1, replicaId: null, latencyNs: Number(end - start) })
        })
        if (payload != null) r.write(payload)
        r.end()
    })
}

async function workerLoop(workerId, factory, stopAt, samplesRef, statusesRef, replicasRef, seqRef) {
    const agent = makeAgent()
    while (Date.now() < stopAt) {
        const seq = seqRef.count++
        const req = factory(workerId, seq)
        const { status, replicaId, latencyNs } = await doRequest(agent, req)
        if (samplesRef.sampling) {
            samplesRef.values.push(latencyNs)
            statusesRef.map.set(status, (statusesRef.map.get(status) || 0) + 1)
            if (replicaId) replicasRef.set.add(replicaId)
        }
    }
    agent.destroy()
}

function percentile(sorted, p) {
    if (sorted.length === 0) return 0
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
    return sorted[idx]
}

async function captureDockerStats(durationMs) {
    const { spawn } = require('child_process')
    return new Promise((resolve) => {
        const proc = spawn('docker', [
            'stats',
            '--no-stream',
            '--format',
            '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.NetIO}}\t{{.BlockIO}}'
        ])
        let out = ''
        proc.stdout.on('data', (c) => (out += c.toString()))
        proc.on('close', () => resolve(out))
        setTimeout(() => proc.kill('SIGKILL'), durationMs + 2000)
    })
}

async function main() {
    const factory = buildRequestFactory(SCENARIO)
    console.error(
        `[perf] server=${SERVER_URL} scenario=${SCENARIO} concurrency=${CONCURRENCY} warmup=${WARMUP_MS}ms duration=${DURATION_MS}ms label=${LABEL || '(none)'}`
    )

    const samples = { sampling: false, values: [] }
    const statuses = { map: new Map() }
    const replicas = { set: new Set() }
    const seq = { count: 0 }

    const warmupEnd = Date.now() + WARMUP_MS
    const measureEnd = warmupEnd + DURATION_MS
    const workers = []
    for (let i = 0; i < CONCURRENCY; i++) {
        workers.push(workerLoop(i, factory, measureEnd, samples, statuses, replicas, seq))
    }

    setTimeout(() => {
        samples.sampling = true
        console.error(`[perf] warmup done, measuring for ${DURATION_MS}ms`)
    }, WARMUP_MS)

    // Stats snapshots: 3 snapshots evenly spread in the measure window.
    const statsSnapshots = []
    for (let i = 1; i <= 3; i++) {
        setTimeout(
            () => {
                captureDockerStats(2000).then((s) => statsSnapshots.push(s))
            },
            WARMUP_MS + (DURATION_MS * i) / 4
        )
    }

    await Promise.all(workers)

    const sorted = samples.values.slice().sort((a, b) => a - b)
    const rps = sorted.length / (DURATION_MS / 1000)
    const toMs = (ns) => Math.round(ns / 1e4) / 100
    const statusEntries = Array.from(statuses.map.entries()).sort((a, b) => a[0] - b[0])

    const summary = {
        label: LABEL,
        scenario: SCENARIO,
        concurrency: CONCURRENCY,
        durationMs: DURATION_MS,
        warmupMs: WARMUP_MS,
        totalSamples: sorted.length,
        rps: Math.round(rps * 100) / 100,
        latencyMs: {
            p50: toMs(percentile(sorted, 50)),
            p90: toMs(percentile(sorted, 90)),
            p95: toMs(percentile(sorted, 95)),
            p99: toMs(percentile(sorted, 99)),
            max: toMs(sorted[sorted.length - 1] || 0),
            min: toMs(sorted[0] || 0),
            mean: toMs(sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1))
        },
        statusCodes: Object.fromEntries(statusEntries),
        replicasSeen: replicas.set.size,
        host: { hostname: os.hostname(), cpus: os.cpus().length },
        timestamp: new Date().toISOString(),
        dockerStatsSnapshots: statsSnapshots
    }

    const outDir = path.resolve(__dirname, '../../../../_output/perf')
    fs.mkdirSync(outDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = path.join(outDir, `${SCENARIO}-${stamp}${LABEL ? '-' + LABEL : ''}.json`)
    fs.writeFileSync(file, JSON.stringify(summary, null, 2))

    console.error(
        `[perf] RPS=${summary.rps}  p50=${summary.latencyMs.p50}ms  p95=${summary.latencyMs.p95}ms  p99=${summary.latencyMs.p99}ms  max=${summary.latencyMs.max}ms  samples=${summary.totalSamples}  statuses=${JSON.stringify(summary.statusCodes)}  replicas=${summary.replicasSeen}`
    )
    console.error(`[perf] wrote ${file}`)
    // single JSON line on stdout for easy piping
    console.log(JSON.stringify(summary))
}

main().catch((e) => {
    console.error('[perf] error:', e)
    process.exit(1)
})
