// Distributed stress test: overlapping showtime-creation saga race.
//
// Two overlapping saga requests are submitted in parallel to nginx. With
// 4 replicas each running its own BullMQ worker, the two jobs can land on
// different workers and run simultaneously. The validator reads existing
// showtimes then inserts — a classic read-then-insert race. A distributed
// lock around validate+create must serialize the pair so exactly one saga
// succeeds and the other reports `failed` with conflictingShowtimes.
//
// Each outer runner invocation repeats the race INNER_ITERATIONS times
// against the same compose stack; successive iters use widely-spaced
// time windows so prior iterations' winning showtimes never interfere.
//
// Fails if: both succeed (overlapping showtimes in DB), both fail
// (neither won), or neither reaches a terminal state in time.
//
// Note: the race is at the worker/Redis layer, not the HTTP layer — the
// two POSTs may or may not land on different replicas, and that is not
// what determines the test outcome.

const http = require('http')

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000'
const INNER_ITERATIONS = Number(process.env.INNER_ITERATIONS || 5)
const SAGA_DEADLINE_MS = Number(process.env.SAGA_DEADLINE_MS || 60_000)

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
                path: url.pathname,
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
                    resolve({
                        status: res.statusCode,
                        body: raw ? JSON.parse(raw) : null,
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

function openSseCollector() {
    const url = new URL('/showtime-creation/event-stream', SERVER_URL)
    const agent = new http.Agent({ keepAlive: false })
    const events = []
    let done = false

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
                    reject(new Error(`SSE status ${res.statusCode}`))
                    return
                }
                res.setEncoding('utf8')
                let buffer = ''
                res.on('data', (chunk) => {
                    if (done) return
                    buffer += chunk
                    let idx
                    while ((idx = buffer.indexOf('\n\n')) !== -1) {
                        const frame = buffer.slice(0, idx)
                        buffer = buffer.slice(idx + 2)
                        const dataLine = frame
                            .split('\n')
                            .find((line) => line.startsWith('data:'))
                        if (!dataLine) continue
                        try {
                            events.push(JSON.parse(dataLine.slice('data:'.length).trim()))
                        } catch {
                            /* ignore */
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
        done = true
        const { res, req, agent: a } = await connected
        res.destroy()
        req.destroy()
        a.destroy()
    }

    return { connected, events, close }
}

async function waitUntil(predicate, { timeoutMs, intervalMs = 100 } = {}) {
    const start = Date.now()
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) return false
        await new Promise((r) => setTimeout(r, intervalMs))
    }
    return true
}

async function setupFixture() {
    const movie = await requestJson('POST', '/movies', {
        title: 'overlap',
        genres: ['action'],
        releaseDate: '2024-01-01T00:00:00.000Z',
        plot: 'overlap plot',
        durationInSeconds: 7200,
        director: 'overlap',
        rating: 'PG',
        assetIds: []
    })
    if (movie.status !== 201) throw new Error(`movie: ${movie.status}`)

    const publish = await requestJson('POST', `/movies/${movie.body.id}/publish`)
    if (publish.status !== 200 && publish.status !== 201) {
        throw new Error(`publish: ${publish.status}`)
    }

    const theater = await requestJson('POST', '/theaters', {
        name: 'overlap',
        location: { latitude: 37.5665, longitude: 126.978 },
        seatmap: {
            blocks: [{ name: 'A', rows: [{ name: '1', layout: 'OOOOOOOO' }] }]
        }
    })
    if (theater.status !== 201) throw new Error(`theater: ${theater.status}`)

    return { movieId: movie.body.id, theaterId: theater.body.id }
}

async function runOnce(iteration, movieId, theaterId, sse, baseOffsetMs) {
    // A runs base..base+2h, B runs base+1h..base+3h (overlap 1h).
    const base = new Date(Date.now() + 24 * 60 * 60 * 1000 + baseOffsetMs)
    base.setUTCSeconds(0, 0)
    base.setUTCMinutes(0)
    const toIso = (d) => d.toISOString().replace(/\.\d{3}Z$/, '.000Z')
    const startA = toIso(base)
    const startB = toIso(new Date(base.getTime() + 60 * 60 * 1000))

    const [a, b] = await Promise.all([
        requestJson('POST', '/showtime-creation/showtimes', {
            movieId,
            theaterIds: [theaterId],
            durationInMinutes: 120,
            startTimes: [startA]
        }),
        requestJson('POST', '/showtime-creation/showtimes', {
            movieId,
            theaterIds: [theaterId],
            durationInMinutes: 120,
            startTimes: [startB]
        })
    ])
    if (a.status !== 202 || b.status !== 202) {
        throw new Error(`iter ${iteration}: creation POST A=${a.status} B=${b.status}`)
    }

    const sagaIds = [a.body.sagaId, b.body.sagaId]

    const terminal = ['succeeded', 'failed', 'error']
    const outcomeOf = (sagaId) =>
        sse.events.find((e) => e.sagaId === sagaId && terminal.includes(e.status))

    const ok = await waitUntil(() => sagaIds.every((id) => outcomeOf(id)), {
        timeoutMs: SAGA_DEADLINE_MS
    })
    if (!ok) {
        for (const id of sagaIds) {
            const e = outcomeOf(id)
            console.error(`  - iter=${iteration} saga ${id} outcome=${e ? e.status : 'none'}`)
        }
        throw new Error(`iter ${iteration}: sagas did not reach terminal state`)
    }

    const outcomes = sagaIds.map(outcomeOf)
    const succeeded = outcomes.filter((e) => e.status === 'succeeded').length
    const failed = outcomes.filter((e) => e.status === 'failed').length

    if (succeeded === 2) {
        throw new Error(`iter ${iteration}: both sagas succeeded — overlap race not prevented`)
    }
    if (succeeded !== 1 || failed !== 1) {
        for (const o of outcomes) console.error(`  - iter=${iteration} ${JSON.stringify(o)}`)
        throw new Error(`iter ${iteration}: succeeded=${succeeded} failed=${failed}`)
    }

    return { succeeded, failed }
}

async function main() {
    console.log(`[overlap] server=${SERVER_URL} inner=${INNER_ITERATIONS}`)

    const { movieId, theaterId } = await setupFixture()
    const sse = openSseCollector()
    await sse.connected

    // Space each iter's time window 6h apart so prior iters' winning
    // showtime (2h long) never overlaps the next iter's candidates.
    const spacingMs = 6 * 60 * 60 * 1000

    try {
        for (let i = 1; i <= INNER_ITERATIONS; i++) {
            await runOnce(i, movieId, theaterId, sse, i * spacingMs)
            console.log(`[overlap] iter ${i}/${INNER_ITERATIONS} OK — 1 succeeded, 1 failed`)
        }
    } finally {
        await sse.close().catch(() => {})
    }

    console.log(`[overlap] PASS: ${INNER_ITERATIONS} iterations`)
}

main().catch((err) => {
    console.error('[overlap] error:', err)
    process.exit(1)
})
