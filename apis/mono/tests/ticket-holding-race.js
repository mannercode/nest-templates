// Distributed stress test: ticket holding race across replicas, multiple
// concurrent ticket sets.
//
// Each inner iteration: provisions a fresh showtime with enough tickets
// for TICKET_GROUPS × 2 tickets, splits the tickets into TICKET_GROUPS
// disjoint pairs, and races CUSTOMERS_PER_GROUP customers per pair.
// Every customer in a group fires a hold on the same pair at the same
// time as every other group. Per group: exactly 1 × 200, rest × 409.
//
// Customers are created once and reused across inner iters; per-iter
// only provisions fresh tickets (held tickets can't be re-raced under
// the same lock key).
//
// Fails if: any group's 200 count != 1, any 5xx, or responses came from
// fewer than 2 replicas.

const http = require('http')

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000'
const TICKET_GROUPS = Number(process.env.HOLD_TICKET_GROUPS || 5)
const CUSTOMERS_PER_GROUP = Number(process.env.HOLD_CLIENT_COUNT || 50)
const INNER_ITERATIONS = Number(process.env.INNER_ITERATIONS || 200)
const SHOWTIME_DEADLINE_MS = Number(process.env.SHOWTIME_DEADLINE_MS || 60_000)

const TOTAL_CUSTOMERS = TICKET_GROUPS * CUSTOMERS_PER_GROUP

function requestRaw(method, path, { body, headers } = {}) {
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
                            /* ignore */
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

async function setupMovieTheater() {
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
    if (movie.status !== 201) throw new Error(`movie: ${movie.status}`)

    const publish = await requestRaw('POST', `/movies/${movie.body.id}/publish`)
    if (publish.status !== 200 && publish.status !== 201) {
        throw new Error(`publish: ${publish.status}`)
    }

    // Big seatmap: 1 block × 1 row × 20 tickets — enough for up to 10 groups.
    const theater = await requestRaw('POST', '/theaters', {
        body: {
            name: 'hold-race',
            location: { latitude: 37.5665, longitude: 126.978 },
            seatmap: {
                blocks: [{ name: 'A', rows: [{ name: '1', layout: 'O'.repeat(20) }] }]
            }
        }
    })
    if (theater.status !== 201) throw new Error(`theater: ${theater.status}`)

    return { movieId: movie.body.id, theaterId: theater.body.id }
}

async function createShowtimeTickets(movieId, theaterId, startTimeOffsetMs) {
    const startTime = new Date(Date.now() + 24 * 60 * 60 * 1000 + startTimeOffsetMs)
        .toISOString()
        .replace(/\.\d{3}Z$/, '.000Z')
    const created = await requestRaw('POST', '/showtime-creation/showtimes', {
        body: {
            movieId,
            theaterIds: [theaterId],
            durationInMinutes: 120,
            startTimes: [startTime]
        }
    })
    if (created.status !== 202) throw new Error(`showtime: ${created.status}`)
    await waitForSagaSuccess(created.body.sagaId)

    const search = await requestRaw('POST', '/showtime-creation/showtimes/search', {
        body: { theaterIds: [theaterId] }
    })
    if (search.status !== 200 || !Array.isArray(search.body) || search.body.length === 0) {
        throw new Error(`showtimes search: ${search.status}`)
    }
    const showtime = search.body.find((s) => s.startTime === startTime) ?? search.body.at(-1)
    const showtimeId = showtime.id

    const tickets = await requestRaw('GET', `/booking/showtimes/${showtimeId}/tickets`)
    if (tickets.status !== 200 || !Array.isArray(tickets.body)) {
        throw new Error(`tickets: ${tickets.status}`)
    }
    if (tickets.body.length < TICKET_GROUPS * 2) {
        throw new Error(
            `tickets: need ${TICKET_GROUPS * 2}, got ${tickets.body.length}`
        )
    }

    // Split into TICKET_GROUPS disjoint pairs.
    const groups = Array.from({ length: TICKET_GROUPS }, (_, g) => [
        tickets.body[g * 2].id,
        tickets.body[g * 2 + 1].id
    ])
    return { showtimeId, groups }
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

async function runInner(iteration, movieId, theaterId, tokens, startTimeOffsetMs) {
    const { showtimeId, groups } = await createShowtimeTickets(
        movieId,
        theaterId,
        startTimeOffsetMs
    )

    // Build attempts: every (group, customer) pair fires a hold on that
    // group's ticket pair. All TICKET_GROUPS × CUSTOMERS_PER_GROUP fire
    // simultaneously via a flat Promise.all.
    const attempts = []
    for (let g = 0; g < TICKET_GROUPS; g++) {
        const ticketIds = groups[g]
        for (let c = 0; c < CUSTOMERS_PER_GROUP; c++) {
            const token = tokens[g * CUSTOMERS_PER_GROUP + c]
            attempts.push(
                requestRaw('POST', `/booking/showtimes/${showtimeId}/tickets/hold`, {
                    body: { ticketIds },
                    headers: { authorization: `Bearer ${token}` }
                }).then((r) => ({ ...r, group: g }))
            )
        }
    }

    const results = await Promise.all(attempts)

    const byGroup = Array.from({ length: TICKET_GROUPS }, () => ({ ok: 0, conflict: 0, other: [] }))
    const replicaSet = new Set()
    for (const r of results) {
        const g = byGroup[r.group]
        if (r.status === 200) g.ok++
        else if (r.status === 409) g.conflict++
        else g.other.push(r)
        if (r.replicaId) replicaSet.add(r.replicaId)
    }

    for (let g = 0; g < TICKET_GROUPS; g++) {
        const slot = byGroup[g]
        if (slot.ok !== 1) {
            console.error(
                `[hold] iter=${iteration} group=${g}: expected 1 × 200, got ${slot.ok}`
            )
            throw new Error(`iter ${iteration} group ${g}: ${slot.ok} × 200`)
        }
        if (slot.other.length > 0) {
            for (const r of slot.other.slice(0, 5)) {
                console.error(
                    `[hold] iter=${iteration} group=${g} unexpected ${r.status} body=${JSON.stringify(r.body)}`
                )
            }
            throw new Error(`iter ${iteration} group ${g}: ${slot.other.length} unexpected`)
        }
    }

    if (replicaSet.size < 2) {
        throw new Error(
            `iter ${iteration}: only 1 replica (got ${[...replicaSet]}) — cross-replica unverified`
        )
    }

    return { total: results.length, replicas: replicaSet.size }
}

async function main() {
    console.log(
        `[hold] server=${SERVER_URL} groups=${TICKET_GROUPS} customers/group=${CUSTOMERS_PER_GROUP} inner=${INNER_ITERATIONS}`
    )

    const { movieId, theaterId } = await setupMovieTheater()
    const tokens = await Promise.all(
        Array.from({ length: TOTAL_CUSTOMERS }, (_, i) => createAndLoginCustomer(i))
    )

    const spacingMs = 3 * 60 * 60 * 1000

    for (let i = 1; i <= INNER_ITERATIONS; i++) {
        const result = await runInner(i, movieId, theaterId, tokens, i * spacingMs)
        console.log(
            `[hold] iter ${i}/${INNER_ITERATIONS} OK — ${result.total} reqs, ${result.replicas} replicas`
        )
    }

    console.log(
        `[hold] PASS: ${INNER_ITERATIONS} iters × ${TICKET_GROUPS} groups × ${CUSTOMERS_PER_GROUP} customers`
    )
}

main().catch((err) => {
    console.error('[hold] error:', err)
    process.exit(1)
})
