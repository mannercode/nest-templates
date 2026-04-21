// Distributed stress test: cross-replica SSE fan-out.
//
// Opens multiple SSE connections via nginx (with a fresh http.Agent per
// connection so TCP-level reuse does not collapse them onto one replica),
// then issues a single showtime-creation POST. With Redis pub/sub wired
// through PubSubService every SSE client — regardless of which replica it
// landed on — must receive the saga's succeeded event.
//
// Each outer runner invocation repeats the race INNER_ITERATIONS times
// against the same compose stack to widen the contention window without
// paying compose-up cost per race.
//
// Fails if: any SSE client does not receive the event, or all SSE clients
// land on the same replica (no cross-replica coverage).

const http = require('http')

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000'
const SSE_CLIENT_COUNT = Number(process.env.SSE_CLIENT_COUNT || 50)
const INNER_ITERATIONS = Number(process.env.INNER_ITERATIONS || 5)
const DEADLINE_MS = Number(process.env.SSE_DEADLINE_MS || 60_000)

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

async function runOnce(movieId, theaterId, iteration, startTimeOffsetMs) {
    const clients = Array.from({ length: SSE_CLIENT_COUNT }, (_, i) => openSseClient(i))
    await Promise.all(clients.map((c) => c.connected))

    const replicaSet = new Set(clients.map((c) => c.getReplicaId()).filter(Boolean))

    const startTime = new Date(Date.now() + 24 * 60 * 60 * 1000 + startTimeOffsetMs)
        .toISOString()
        .replace(/\.\d{3}Z$/, '.000Z')
    const createRes = await requestJson('POST', '/showtime-creation/showtimes', {
        movieId,
        theaterIds: [theaterId],
        durationInMinutes: 120,
        startTimes: [startTime]
    })
    if (createRes.status !== 202) {
        await Promise.all(clients.map((c) => c.close().catch(() => {})))
        throw new Error(`showtime creation rejected: ${createRes.status}`)
    }
    const sagaId = createRes.body.sagaId

    const received = await Promise.all(
        clients.map(async (client) => {
            const ok = await waitUntil(
                () =>
                    client.events.some(
                        (e) => e && e.sagaId === sagaId && e.status === 'succeeded'
                    ),
                { timeoutMs: DEADLINE_MS }
            )
            return { clientId: client.clientId, replicaId: client.getReplicaId(), ok }
        })
    )

    await Promise.all(clients.map((c) => c.close().catch(() => {})))

    const missing = received.filter((r) => !r.ok)
    if (missing.length) {
        console.error(
            `[sse] iter=${iteration} ${missing.length}/${received.length} clients missed the succeeded event`
        )
        for (const m of missing) {
            console.error(`  - client ${m.clientId} replica=${m.replicaId}`)
        }
        throw new Error(`iter ${iteration} missed events`)
    }

    if (replicaSet.size < 2) {
        throw new Error(
            `iter ${iteration}: only 1 replica served SSE (got ${[...replicaSet]}) — cross-replica unverified`
        )
    }

    return { received: received.length, replicas: replicaSet.size }
}

async function main() {
    console.log(
        `[sse] server=${SERVER_URL} clients=${SSE_CLIENT_COUNT} inner=${INNER_ITERATIONS}`
    )

    const { movieId, theaterId } = await setupFixture()

    // Space consecutive sagas apart so overlap detection never rejects them.
    // Per iter shift = max duration + margin.
    const spacingMs = 3 * 60 * 60 * 1000

    for (let i = 1; i <= INNER_ITERATIONS; i++) {
        const result = await runOnce(movieId, theaterId, i, i * spacingMs)
        console.log(
            `[sse] iter ${i}/${INNER_ITERATIONS} OK — ${result.received} clients, ${result.replicas} replicas`
        )
    }

    console.log(`[sse] PASS: ${INNER_ITERATIONS} iterations × ${SSE_CLIENT_COUNT} clients`)
}

main().catch((err) => {
    console.error('[sse] error:', err)
    process.exit(1)
})
