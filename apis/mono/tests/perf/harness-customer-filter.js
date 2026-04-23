// Customer filter 전용 perf 하네스 (cycle-15b 검증용).
//
// GET /customers 가 JWT 보호이므로 worker 마다 자체 계정으로 register + login
// 하고 access token 을 받아 `?name=<prefix>` 필터 쿼리를 루프 실행.
//
// 비교 기준: cycle-09 theater 필터 baseline 23 RPS → cycle-12 compound index
// 3776 RPS (150x). customers 는 같은 CrudRepository + compound index 구조
// (cycle-15b) 라 유사한 수준 기대.
//
// Env: SERVER_URL, CONCURRENCY, DURATION_MS, WARMUP_MS, LABEL, FILTER_PREFIX

const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000'
const CONCURRENCY = Number(process.env.CONCURRENCY || 100)
const DURATION_MS = Number(process.env.DURATION_MS || 30_000)
const WARMUP_MS = Number(process.env.WARMUP_MS || 3_000)
const LABEL = process.env.LABEL || ''
// prefix-mode + case-sensitive 적용 상태에선 substring 매치 불가. 실제 검색
// UX 시뮬 (앞 글자부터 타이핑) — 좁은 prefix 로 match 수 적게 유지.
const FILTER_PREFIX = process.env.FILTER_PREFIX || 'perf-customer-17769404'

const url = new URL(SERVER_URL)

function makeAgent() {
    return new http.Agent({ keepAlive: true, maxSockets: 4 })
}

function doRequest(agent, method, pathname, body, authHeader) {
    const payload = body == null ? null : JSON.stringify(body)
    return new Promise((resolve) => {
        const start = process.hrtime.bigint()
        const headers = { accept: 'application/json' }
        if (authHeader) headers['authorization'] = authHeader
        if (payload != null) {
            headers['content-type'] = 'application/json'
            headers['content-length'] = Buffer.byteLength(payload)
        }
        const r = http.request(
            { agent, hostname: url.hostname, port: url.port, path: pathname, method, headers },
            (res) => {
                const chunks = []
                res.on('data', (c) => chunks.push(c))
                res.on('end', () => {
                    const end = process.hrtime.bigint()
                    let parsed = null
                    try {
                        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
                    } catch {}
                    resolve({
                        status: res.statusCode,
                        replicaId: res.headers['x-replica-id'] || null,
                        body: parsed,
                        latencyNs: Number(end - start)
                    })
                })
            }
        )
        r.on('error', () => {
            const end = process.hrtime.bigint()
            resolve({ status: -1, replicaId: null, body: null, latencyNs: Number(end - start) })
        })
        if (payload != null) r.write(payload)
        r.end()
    })
}

async function setupWorker(workerId, seed) {
    const agent = makeAgent()
    const email = `perf-customer-filter.${seed}.${workerId}@example.com`
    const password = 'filterprobepass'

    const create = await doRequest(agent, 'POST', '/customers', {
        name: `probe-${workerId}`,
        email,
        password,
        birthDate: '1990-01-01T00:00:00.000Z'
    })
    if (create.status !== 201) {
        // email 중복 시 무시하고 login 진행
        if (create.status !== 409) {
            agent.destroy()
            throw new Error(`worker ${workerId} create returned ${create.status}`)
        }
    }

    const login = await doRequest(agent, 'POST', '/customers/login', { email, password })
    if (login.status !== 200 || !login.body || !login.body.accessToken) {
        agent.destroy()
        throw new Error(`worker ${workerId} login returned ${login.status}`)
    }

    return { agent, authHeader: `Bearer ${login.body.accessToken}` }
}

async function workerLoop(state, stopAt, samples, statuses, replicas) {
    const path = `/customers?page=1&size=50&name=${encodeURIComponent(FILTER_PREFIX)}`
    while (Date.now() < stopAt) {
        const r = await doRequest(state.agent, 'GET', path, null, state.authHeader)
        if (samples.sampling) {
            samples.values.push(r.latencyNs)
            statuses.map.set(r.status, (statuses.map.get(r.status) || 0) + 1)
            if (r.replicaId) replicas.set.add(r.replicaId)
        }
    }
}

function percentile(sorted, p) {
    if (sorted.length === 0) return 0
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
    return sorted[idx]
}

async function main() {
    console.error(
        `[customer-filter] concurrency=${CONCURRENCY} warmup=${WARMUP_MS}ms duration=${DURATION_MS}ms prefix="${FILTER_PREFIX}" label=${LABEL || '(none)'}`
    )
    const seed = Date.now()
    console.error(`[customer-filter] setup ${CONCURRENCY} workers...`)
    const t0 = Date.now()
    const workerStates = await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) => setupWorker(i, seed))
    )
    console.error(`[customer-filter] setup done in ${Date.now() - t0} ms`)

    const samples = { sampling: false, values: [] }
    const statuses = { map: new Map() }
    const replicas = { set: new Set() }

    const measureEnd = Date.now() + WARMUP_MS + DURATION_MS
    setTimeout(() => {
        samples.sampling = true
        console.error(`[customer-filter] warmup done`)
    }, WARMUP_MS)

    await Promise.all(
        workerStates.map((s) => workerLoop(s, measureEnd, samples, statuses, replicas))
    )
    for (const s of workerStates) s.agent.destroy()

    const sorted = samples.values.slice().sort((a, b) => a - b)
    const rps = sorted.length / (DURATION_MS / 1000)
    const toMs = (ns) => Math.round(ns / 1e4) / 100

    const summary = {
        label: LABEL,
        scenario: 'customer-read-name-filter',
        filterPrefix: FILTER_PREFIX,
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
        statusCodes: Object.fromEntries(
            Array.from(statuses.map.entries()).sort((a, b) => a[0] - b[0])
        ),
        replicasSeen: replicas.set.size,
        host: { hostname: os.hostname(), cpus: os.cpus().length },
        timestamp: new Date().toISOString()
    }

    const outDir = path.resolve(__dirname, '../../../../_output/perf')
    fs.mkdirSync(outDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = path.join(outDir, `customer-filter-${stamp}${LABEL ? '-' + LABEL : ''}.json`)
    fs.writeFileSync(file, JSON.stringify(summary, null, 2))

    console.error(
        `[customer-filter] RPS=${summary.rps}  p50=${summary.latencyMs.p50}ms  p95=${summary.latencyMs.p95}ms  p99=${summary.latencyMs.p99}ms  statuses=${JSON.stringify(summary.statusCodes)}  replicas=${summary.replicasSeen}`
    )
    console.error(`[customer-filter] wrote ${file}`)
    console.log(JSON.stringify(summary))
}

main().catch((e) => {
    console.error('[customer-filter] error:', e)
    process.exit(1)
})
