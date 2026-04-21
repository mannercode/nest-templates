// Distributed stress test: cross-replica SSE fan-out under heavy load.
//
// Each inner iteration: opens SSE_CLIENT_COUNT SSE connections across
// replicas, fires SAGAS_PER_INNER saga-creation POSTs simultaneously
// (each with a distinct staggered startTime), and asserts that every
// SSE client receives every saga's succeeded event. The pass condition
// is SSE_CLIENT_COUNT × SAGAS_PER_INNER events delivered correctly.
//
// Per inner iter exercises thousands of Redis pub/sub messages because
// each replica publishes status changes for each saga (Waiting →
// Processing → Succeeded) and every subscriber forwards to its
// local Subject.
//
// Fails if: any SSE client misses any saga's succeeded event, or SSE
// clients landed on fewer than 2 replicas (no cross-replica coverage).

const http = require('http')

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000'
const SSE_CLIENT_COUNT = Number(process.env.SSE_CLIENT_COUNT || 100)
const SAGAS_PER_INNER = Number(process.env.SAGAS_PER_INNER || 20)
const INNER_ITERATIONS = Number(process.env.INNER_ITERATIONS || 30)
const DEADLINE_MS = Number(process.env.SSE_DEADLINE_MS || 120_000)

function requestJson(method, path, body) {
    const url = new URL(path, SERVER_URL)
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const agent = new http.Agent({ keepAlive: false })

    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                agent,
                hostname: url.hostname,
                port: url.port,
                path: url.pathname + url.search,
                method,
                headers: {
                    'content-type': 'application/json',
                    ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {})
                }
            },
            (res) => {
                const chunks = []
                res.on('data', (c) => chunks.push(c))
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8')
                    const parsed = raw ? JSON.parse(raw) : null
                    resolve({
                        status: res.statusCode,
                        body: parsed,
                        replicaId: res.headers['x-replica-id']
                    })
                    agent.destroy()
                })
            }
        )
        req.on('error', reject)
        if (payload) req.write(payload)
        req.end()
    })
}

function openSseClient(clientId) {
    const url = new URL('/showtime-creation/event-stream', SERVER_URL)
    const agent = new http.Agent({ keepAlive: false })
    const events = []
    let replicaId

    const connected = new Promise((resolve, reject) => {
        const req = http.request(
            {
                agent,
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'GET',
                headers: { accept: 'text/event-stream' }
            },
            (res) => {
                if (res.statusCode !== 200) {
                    reject(new Error(`SSE client ${clientId} got status ${res.statusCode}`))
                    return
                }
                replicaId = res.headers['x-replica-id']
                res.setEncoding('utf8')
                let buffer = ''
                res.on('data', (chunk) => {
                    buffer += chunk
                    let idx
                    while ((idx = buffer.indexOf('\n\n')) !== -1) {
                        const frame = buffer.slice(0, idx)
                        buffer = buffer.slice(idx + 2)
                        const dataLine = frame
                            .split('\n')
                            .find((line) => line.startsWith('data:'))
                        if (!dataLine) continue
                        const payload = dataLine.slice('data:'.length).trim()
                        try {
                            events.push(JSON.parse(payload))
                        } catch {
                            events.push({ raw: payload })
                        }
                    }
                })
                resolve({ res, req, agent })
            }
        )
        req.on('error', reject)
        req.end()
    })

    const close = async () => {
        const { res, req, agent: a } = await connected
        res.destroy()
        req.destroy()
        a.destroy()
    }

    return { clientId, connected, events, close, getReplicaId: () => replicaId }
}

async function waitUntil(predicate, { timeoutMs, intervalMs = 50 } = {}) {
    const start = Date.now()
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) return false
        await new Promise((r) => setTimeout(r, intervalMs))
    }
    return true
}

async function setupFixture() {
    const movie = await requestJson('POST', '/movies', {
        title: 'stress-movie',
        genres: ['action'],
        releaseDate: '2024-01-01T00:00:00.000Z',
        plot: 'stress plot',
        durationInSeconds: 7200,
        director: 'stress',
        rating: 'PG',
        assetIds: []
    })
    if (movie.status !== 201) throw new Error(`movie create failed: ${movie.status}`)

    const publish = await requestJson('POST', `/movies/${movie.body.id}/publish`)
    if (publish.status !== 200 && publish.status !== 201) {
        throw new Error(`movie publish failed: ${publish.status}`)
    }

    const theater = await requestJson('POST', '/theaters', {
        name: 'stress-theater',
        location: { latitude: 37.5665, longitude: 126.978 },
        seatmap: {
            blocks: [{ name: 'A', rows: [{ name: '1', layout: 'OOOOOOOO' }] }]
        }
    })
    if (theater.status !== 201) throw new Error(`theater create failed: ${theater.status}`)

    return { movieId: movie.body.id, theaterId: theater.body.id }
}

async function runInner(movieId, theaterId, iteration, baseOffsetMs) {
    // Open a fresh batch of SSE clients per iter.
    const clients = Array.from({ length: SSE_CLIENT_COUNT }, (_, i) => openSseClient(i))
    await Promise.all(clients.map((c) => c.connected))

    const replicaSet = new Set(clients.map((c) => c.getReplicaId()).filter(Boolean))
    if (replicaSet.size < 2) {
        await Promise.all(clients.map((c) => c.close().catch(() => {})))
        throw new Error(
            `iter ${iteration}: only 1 replica served SSE (got ${[...replicaSet]}) — cross-replica unverified`
        )
    }

    // Fire SAGAS_PER_INNER sagas at once. Each uses a distinct non-overlapping
    // startTime so the validator doesn't reject them.
    const sagaSpacingMs = 3 * 60 * 60 * 1000 // 3h
    const sagaPromises = Array.from({ length: SAGAS_PER_INNER }, (_, i) => {
        const startTime = new Date(
            Date.now() + 24 * 60 * 60 * 1000 + baseOffsetMs + i * sagaSpacingMs
        )
            .toISOString()
            .replace(/\.\d{3}Z$/, '.000Z')
        return requestJson('POST', '/showtime-creation/showtimes', {
            movieId,
            theaterIds: [theaterId],
            durationInMinutes: 120,
            startTimes: [startTime]
        })
    })

    const postResults = await Promise.all(sagaPromises)
    const sagaIds = postResults.map((r) => {
        if (r.status !== 202) throw new Error(`iter ${iteration}: saga POST status ${r.status}`)
        return r.body.sagaId
    })

    // Every client must receive every saga's succeeded event.
    const ok = await waitUntil(
        () =>
            clients.every((c) =>
                sagaIds.every((id) =>
                    c.events.some((e) => e && e.sagaId === id && e.status === 'succeeded')
                )
            ),
        { timeoutMs: DEADLINE_MS }
    )

    await Promise.all(clients.map((c) => c.close().catch(() => {})))

    if (!ok) {
        const missing = []
        for (const c of clients) {
            for (const sagaId of sagaIds) {
                if (!c.events.some((e) => e && e.sagaId === sagaId && e.status === 'succeeded')) {
                    missing.push({ client: c.clientId, sagaId, replicaId: c.getReplicaId() })
                }
            }
        }
        console.error(
            `[sse] iter=${iteration} ${missing.length} client×saga pairs missed succeeded`
        )
        for (const m of missing.slice(0, 20)) {
            console.error(`  - client ${m.client} saga ${m.sagaId} replica=${m.replicaId}`)
        }
        if (missing.length > 20) console.error(`  ... ${missing.length - 20} more`)
        throw new Error(`iter ${iteration}: ${missing.length} missing events`)
    }

    const totalEvents = SSE_CLIENT_COUNT * SAGAS_PER_INNER
    return { events: totalEvents, replicas: replicaSet.size }
}

async function main() {
    console.log(
        `[sse] server=${SERVER_URL} clients=${SSE_CLIENT_COUNT} sagas=${SAGAS_PER_INNER} inner=${INNER_ITERATIONS}`
    )

    const { movieId, theaterId } = await setupFixture()

    // Each inner iter uses SAGAS_PER_INNER × 3h of timeline starting at
    // baseOffset; space iterations far enough apart that they don't collide.
    const iterSpacingMs = SAGAS_PER_INNER * 3 * 60 * 60 * 1000 + 24 * 60 * 60 * 1000

    for (let i = 1; i <= INNER_ITERATIONS; i++) {
        const result = await runInner(movieId, theaterId, i, i * iterSpacingMs)
        console.log(
            `[sse] iter ${i}/${INNER_ITERATIONS} OK — ${result.events} events delivered, ${result.replicas} replicas`
        )
    }

    console.log(
        `[sse] PASS: ${INNER_ITERATIONS} iters × ${SSE_CLIENT_COUNT} clients × ${SAGAS_PER_INNER} sagas`
    )
}

main().catch((err) => {
    console.error('[sse] error:', err)
    process.exit(1)
})
