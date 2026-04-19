// Distributed stress test: ticket holding race across replicas.
//
// N customers log in against different replicas, then all try to hold the
// same ticketIds on the same showtime at the same time. TicketHoldingService
// uses Redis SET NX under the hood so exactly one customer must win the
// hold (200) and the rest must get 409. A tie (multiple 200s) would mean
// the Redis lock is broken or bypassed.
//
// Fails if: not exactly one 200, any 5xx, or requests all landed on one
// replica (no cross-replica coverage).

const http = require('http')

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000'
const CLIENT_COUNT = Number(process.env.HOLD_CLIENT_COUNT || 20)
const SHOWTIME_DEADLINE_MS = Number(process.env.SHOWTIME_DEADLINE_MS || 60_000)

function requestRaw(method, path, { body, headers, accept } = {}) {
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
                    ...(accept ? { accept } : {}),
                    ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
                    ...(headers || {})
                }
            },
            (res) => {
                const chunks = []
                res.on('data', (c) => chunks.push(c))
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8')
                    let parsed = null
                    try {
                        parsed = raw ? JSON.parse(raw) : null
                    } catch {
                        parsed = raw
                    }
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

function waitForSagaSuccess(sagaId) {
    const url = new URL('/showtime-creation/event-stream', SERVER_URL)
    const agent = new http.Agent({ keepAlive: false })
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            agent.destroy()
            reject(new Error(`saga ${sagaId} did not finish in ${SHOWTIME_DEADLINE_MS}ms`))
        }, SHOWTIME_DEADLINE_MS)

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
                let buffer = ''
                res.setEncoding('utf8')
                res.on('data', (chunk) => {
                    buffer += chunk
                    let idx
                    while ((idx = buffer.indexOf('\n\n')) !== -1) {
                        const frame = buffer.slice(0, idx)
                        buffer = buffer.slice(idx + 2)
                        const dataLine = frame.split('\n').find((line) => line.startsWith('data:'))
                        if (!dataLine) continue
                        try {
                            const event = JSON.parse(dataLine.slice('data:'.length).trim())
                            if (event.sagaId !== sagaId) continue
                            if (event.status === 'succeeded') {
                                clearTimeout(timer)
                                res.destroy()
                                agent.destroy()
                                resolve()
                                return
                            }
                            if (event.status === 'failed' || event.status === 'error') {
                                clearTimeout(timer)
                                res.destroy()
                                agent.destroy()
                                reject(new Error(`saga ${sagaId} status=${event.status}`))
                                return
                            }
                        } catch {
                            /* ignore non-JSON frames */
                        }
                    }
                })
                res.on('error', reject)
            }
        )
        req.on('error', reject)
        req.end()
    })
}

async function setupShowtime() {
    const movie = await requestRaw('POST', '/movies', {
        body: {
            title: 'hold-race',
            genres: ['action'],
            releaseDate: '2024-01-01T00:00:00.000Z',
            plot: 'plot',
            durationInSeconds: 7200,
            director: 'director',
            rating: 'PG',
            assetIds: []
        }
    })
    if (movie.status !== 201) throw new Error(`movie create: ${movie.status}`)

    const publish = await requestRaw('POST', `/movies/${movie.body.id}/publish`)
    if (publish.status !== 200 && publish.status !== 201) {
        throw new Error(`movie publish: ${publish.status}`)
    }

    const theater = await requestRaw('POST', '/theaters', {
        body: {
            name: 'hold-race',
            location: { latitude: 37.5665, longitude: 126.978 },
            seatmap: {
                blocks: [{ name: 'A', rows: [{ name: '1', layout: 'OOOOOOOO' }] }]
            }
        }
    })
    if (theater.status !== 201) throw new Error(`theater create: ${theater.status}`)

    const startTime = new Date(Date.now() + 24 * 60 * 60 * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, '.000Z')
    const created = await requestRaw('POST', '/showtime-creation/showtimes', {
        body: {
            movieId: movie.body.id,
            theaterIds: [theater.body.id],
            durationInMinutes: 120,
            startTimes: [startTime]
        }
    })
    if (created.status !== 202) throw new Error(`showtime request: ${created.status}`)

    await waitForSagaSuccess(created.body.sagaId)

    const search = await requestRaw('POST', '/showtime-creation/showtimes/search', {
        body: { theaterIds: [theater.body.id] }
    })
    if (search.status !== 200 || !Array.isArray(search.body) || search.body.length === 0) {
        throw new Error(`showtimes search: status=${search.status} body=${JSON.stringify(search.body)}`)
    }
    const showtimeId = search.body[0].id

    const tickets = await requestRaw('GET', `/booking/showtimes/${showtimeId}/tickets`)
    if (tickets.status !== 200 || !Array.isArray(tickets.body) || tickets.body.length === 0) {
        throw new Error(`tickets fetch: status=${tickets.status}`)
    }
    const ticketIds = tickets.body.slice(0, 2).map((t) => t.id)
    return { showtimeId, ticketIds }
}

async function createAndLoginCustomer(index) {
    const email = `hold.${Date.now()}.${index}.${Math.random().toString(36).slice(2)}@example.com`
    const password = 'holdpassword'
    const create = await requestRaw('POST', '/customers', {
        body: { name: `hold-${index}`, birthDate: '1990-01-01T00:00:00.000Z', email, password }
    })
    if (create.status !== 201) throw new Error(`customer create ${index}: ${create.status}`)

    const login = await requestRaw('POST', '/customers/login', {
        body: { email, password }
    })
    if (login.status !== 200 && login.status !== 201) {
        throw new Error(`customer login ${index}: ${login.status}`)
    }
    return login.body.accessToken
}

async function main() {
    console.log(`[hold] server=${SERVER_URL} clients=${CLIENT_COUNT}`)

    const { showtimeId, ticketIds } = await setupShowtime()
    console.log(`[hold] showtimeId=${showtimeId} ticketIds=${ticketIds.join(',')}`)

    const tokens = await Promise.all(
        Array.from({ length: CLIENT_COUNT }, (_, i) => createAndLoginCustomer(i))
    )

    const results = await Promise.all(
        tokens.map((token) =>
            requestRaw('POST', `/booking/showtimes/${showtimeId}/tickets/hold`, {
                body: { ticketIds },
                headers: { authorization: `Bearer ${token}` }
            })
        )
    )

    const byStatus = new Map()
    const replicaSet = new Set()
    for (const r of results) {
        byStatus.set(r.status, (byStatus.get(r.status) || 0) + 1)
        if (r.replicaId) replicaSet.add(r.replicaId)
    }
    console.log(
        `[hold] statuses=${JSON.stringify(Object.fromEntries(byStatus))} replicas=${replicaSet.size}`
    )

    const ok = byStatus.get(200) || 0
    const conflict = byStatus.get(409) || 0
    const other = CLIENT_COUNT - ok - conflict

    if (ok !== 1) {
        console.error(`[hold] expected exactly 1 hold to succeed, got ${ok}`)
        for (const r of results) console.error(`  - ${r.status} replica=${r.replicaId}`)
        process.exit(1)
    }
    if (other !== 0) {
        console.error(`[hold] unexpected non-200/409 responses: ${other}`)
        for (const r of results.filter((x) => x.status !== 200 && x.status !== 409)) {
            console.error(`  - ${r.status} replica=${r.replicaId} body=${JSON.stringify(r.body)}`)
        }
        process.exit(1)
    }
    if (replicaSet.size < 2) {
        console.error(`[hold] only 1 replica served (got ${[...replicaSet]}) — cross-replica unverified`)
        process.exit(1)
    }

    console.log(`[hold] PASS: 1×200, ${conflict}×409 across ${replicaSet.size} replicas`)
}

main().catch((err) => {
    console.error('[hold] error:', err)
    process.exit(1)
})
