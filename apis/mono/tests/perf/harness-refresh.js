// Sustained-load perf harness for the customer-refresh path.
//
// POST /customers/refresh exercises Redis on every call: read the prior
// refresh token (GET against the cluster), generate new access+refresh
// JWTs, store the new refresh token (SET with TTL). No bcrypt, no DB read
// for the token itself — JWT verify is in-memory. So this is the closest
// clean signal we can get for ioredis cluster throughput from inside the
// app.
//
// Setup: concurrent workers each register and log in once before the
// measurement window, then loop refreshing their own token. Each worker
// holds its own refresh token to avoid cross-worker invalidation races
// (a refresh atomically rotates the stored token).
//
// Env: same shape as harness.js — SERVER_URL, CONCURRENCY, DURATION_MS,
// WARMUP_MS, LABEL.

const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000'
const CONCURRENCY = Number(process.env.CONCURRENCY || 100)
const DURATION_MS = Number(process.env.DURATION_MS || 30_000)
const WARMUP_MS = Number(process.env.WARMUP_MS || 3_000)
const LABEL = process.env.LABEL || ''

const url = new URL(SERVER_URL)

function makeAgent() {
    return new http.Agent({ keepAlive: true, maxSockets: 4 })
}

function uniqueEmail(workerId, seed) {
    return `perf-refresh.${seed}.${workerId}.${Math.random().toString(36).slice(2, 8)}@example.com`
}

function doRequest(agent, method, pathname, body) {
    const payload = body == null ? null : JSON.stringify(body)
    return new Promise((resolve) => {
        const start = process.hrtime.bigint()
        const headers = { accept: 'application/json' }
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
    const email = uniqueEmail(workerId, seed)
    const password = 'refreshpass'

    const create = await doRequest(agent, 'POST', '/customers', {
        name: `r${workerId}`,
        email,
        password,
        birthDate: '1990-01-01T00:00:00.000Z'
    })
    if (create.status !== 201) {
        agent.destroy()
        throw new Error(`worker ${workerId} setup: create returned ${create.status}`)
    }

    const login = await doRequest(agent, 'POST', '/customers/login', { email, password })
    if (login.status !== 200 || !login.body || !login.body.refreshToken) {
        agent.destroy()
        throw new Error(`worker ${workerId} setup: login returned ${login.status}`)
    }

    return { agent, refreshToken: login.body.refreshToken }
}

async function workerLoop(workerId, state, stopAt, samplesRef, statusesRef, replicasRef) {
    while (Date.now() < stopAt) {
        const result = await doRequest(state.agent, 'POST', '/customers/refresh', {
            refreshToken: state.refreshToken
        })
        if (samplesRef.sampling) {
            samplesRef.values.push(result.latencyNs)
            statusesRef.map.set(result.status, (statusesRef.map.get(result.status) || 0) + 1)
            if (result.replicaId) replicasRef.set.add(result.replicaId)
        }
        // Even outside the measurement window, rotate so the stored token
        // stays consistent.
        if (result.status === 200 && result.body && result.body.refreshToken) {
            state.refreshToken = result.body.refreshToken
        } else if (result.status !== 200) {
            // Token invalidated (e.g. another concurrent refresh under same
            // user, shouldn't happen with isolated workers). Bail this worker.
            return
        }
    }
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
    console.error(
        `[perf-refresh] server=${SERVER_URL} concurrency=${CONCURRENCY} warmup=${WARMUP_MS}ms duration=${DURATION_MS}ms label=${LABEL || '(none)'}`
    )

    // Setup phase. Each worker creates its own customer + logs in.
    const seed = Date.now()
    console.error(`[perf-refresh] setting up ${CONCURRENCY} customers...`)
    const setupT0 = Date.now()
    const workerStates = await Promise.all(
        Array.from({ length: CONCURRENCY }, (_, i) => setupWorker(i, seed))
    )
    console.error(`[perf-refresh] setup done in ${Date.now() - setupT0} ms`)

    const samples = { sampling: false, values: [] }
    const statuses = { map: new Map() }
    const replicas = { set: new Set() }

    const warmupEnd = Date.now() + WARMUP_MS
    const measureEnd = warmupEnd + DURATION_MS

    setTimeout(() => {
        samples.sampling = true
        console.error(`[perf-refresh] warmup done, measuring for ${DURATION_MS}ms`)
    }, WARMUP_MS)

    const statsSnapshots = []
    for (let i = 1; i <= 3; i++) {
        setTimeout(
            () => {
                captureDockerStats(2000).then((s) => statsSnapshots.push(s))
            },
            WARMUP_MS + (DURATION_MS * i) / 4
        )
    }

    const workers = workerStates.map((state, i) =>
        workerLoop(i, state, measureEnd, samples, statuses, replicas)
    )
    await Promise.all(workers)

    for (const s of workerStates) s.agent.destroy()

    const sorted = samples.values.slice().sort((a, b) => a - b)
    const rps = sorted.length / (DURATION_MS / 1000)
    const toMs = (ns) => Math.round(ns / 1e4) / 100
    const statusEntries = Array.from(statuses.map.entries()).sort((a, b) => a[0] - b[0])

    const summary = {
        label: LABEL,
        scenario: 'customer-refresh',
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
    const file = path.join(outDir, `customer-refresh-${stamp}${LABEL ? '-' + LABEL : ''}.json`)
    fs.writeFileSync(file, JSON.stringify(summary, null, 2))

    console.error(
        `[perf-refresh] RPS=${summary.rps}  p50=${summary.latencyMs.p50}ms  p95=${summary.latencyMs.p95}ms  p99=${summary.latencyMs.p99}ms  max=${summary.latencyMs.max}ms  samples=${summary.totalSamples}  statuses=${JSON.stringify(summary.statusCodes)}  replicas=${summary.replicasSeen}`
    )
    console.error(`[perf-refresh] wrote ${file}`)
    console.log(JSON.stringify(summary))
}

main().catch((e) => {
    console.error('[perf-refresh] error:', e)
    process.exit(1)
})
