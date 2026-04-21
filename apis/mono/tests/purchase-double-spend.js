// Distributed stress test: purchase double-spend race — concurrent groups.
//
// Each inner iteration: provisions a fresh showtime and CUSTOMER_GROUPS
// customers each hold a distinct ticket pair. Every customer then fires
// PURCHASES_PER_GROUP concurrent POST /purchases on their own ticket
// pair. All CUSTOMER_GROUPS × PURCHASES_PER_GROUP requests fire
// simultaneously. Per group: exactly 1 × 2xx success, rest × 4xx
// (409 AlreadySold / 400 NotHeld).
//
// Movie/theater and customer accounts are created once outside the loop;
// per-iter work is the fresh showtime, tickets, holds, and race.
//
// Fails if: any group != 1 success, any 5xx, or fewer than 2 replicas
// served the requests.

const http = require('http')

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000'
const CUSTOMER_GROUPS = Number(process.env.PURCHASE_CUSTOMER_GROUPS || 5)
const PURCHASES_PER_GROUP = Number(process.env.PURCHASE_CLIENT_COUNT || 50)
const INNER_ITERATIONS = Number(process.env.INNER_ITERATIONS || 150)
const SHOWTIME_DEADLINE_MS = Number(process.env.SHOWTIME_DEADLINE_MS || 60_000)

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
            title: 'purchase-race',
            genres: ['action'],
            releaseDate: '2024-01-01T00:00:00.000Z',
            plot: 'plot',
            durationInSeconds: 7200,
            director: 'dir',
            rating: 'PG',
            assetIds: []
        }
    })
    if (movie.status !== 201) throw new Error(`movie: ${movie.status}`)

    const publish = await requestRaw('POST', `/movies/${movie.body.id}/publish`)
    if (publish.status !== 200 && publish.status !== 201) {
        throw new Error(`publish: ${publish.status}`)
    }

    // Big seatmap so we can carve out CUSTOMER_GROUPS disjoint ticket pairs.
    const theater = await requestRaw('POST', '/theaters', {
        body: {
            name: 'purchase-race',
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
    if (tickets.body.length < CUSTOMER_GROUPS * 2) {
        throw new Error(`tickets: need ${CUSTOMER_GROUPS * 2}, got ${tickets.body.length}`)
    }

    const groups = Array.from({ length: CUSTOMER_GROUPS }, (_, g) => [
        tickets.body[g * 2].id,
        tickets.body[g * 2 + 1].id
    ])
    return { showtimeId, groups }
}

async function createAndLoginCustomer(index) {
    const email = `purchase.${Date.now()}.${index}.${Math.random().toString(36).slice(2)}@example.com`
    const password = 'purchasepass'
    const create = await requestRaw('POST', '/customers', {
        body: { name: `pur-${index}`, birthDate: '1990-01-01T00:00:00.000Z', email, password }
    })
    if (create.status !== 201) throw new Error(`customer create ${index}: ${create.status}`)

    const login = await requestRaw('POST', '/customers/login', {
        body: { email, password }
    })
    if (login.status !== 200 && login.status !== 201) {
        throw new Error(`customer login ${index}: ${login.status}`)
    }
    return { customerId: create.body.id, accessToken: login.body.accessToken }
}

async function runInner(iteration, movieId, theaterId, customers, startTimeOffsetMs) {
    const { showtimeId, groups } = await createShowtimeTickets(
        movieId,
        theaterId,
        startTimeOffsetMs
    )

    // Each customer holds their group's ticket pair.
    await Promise.all(
        customers.map(async (cust, g) => {
            const hold = await requestRaw(
                'POST',
                `/booking/showtimes/${showtimeId}/tickets/hold`,
                {
                    body: { ticketIds: groups[g] },
                    headers: { authorization: `Bearer ${cust.accessToken}` }
                }
            )
            if (hold.status !== 200) {
                throw new Error(
                    `iter ${iteration} group=${g}: hold status=${hold.status}`
                )
            }
        })
    )

    // All customers fire PURCHASES_PER_GROUP concurrent purchases at once.
    const attempts = []
    for (let g = 0; g < CUSTOMER_GROUPS; g++) {
        const cust = customers[g]
        const purchaseItems = groups[g].map((id) => ({ itemId: id, type: 'tickets' }))
        const totalPrice = groups[g].length * 1000
        for (let c = 0; c < PURCHASES_PER_GROUP; c++) {
            attempts.push(
                requestRaw('POST', '/purchases', {
                    body: {
                        customerId: cust.customerId,
                        purchaseItems,
                        totalPrice
                    }
                }).then((r) => ({ ...r, group: g }))
            )
        }
    }

    const results = await Promise.all(attempts)

    const byGroup = Array.from({ length: CUSTOMER_GROUPS }, () => ({ ok: 0, rejected: 0, other: [] }))
    const replicaSet = new Set()
    for (const r of results) {
        const slot = byGroup[r.group]
        if (r.status >= 200 && r.status < 300) slot.ok++
        else if (r.status >= 400 && r.status < 500) slot.rejected++
        else slot.other.push(r)
        if (r.replicaId) replicaSet.add(r.replicaId)
    }

    for (let g = 0; g < CUSTOMER_GROUPS; g++) {
        const slot = byGroup[g]
        if (slot.ok !== 1) {
            console.error(
                `[purchase] iter=${iteration} group=${g}: expected 1 × success, got ${slot.ok}`
            )
            for (const r of results.filter((x) => x.group === g && x.status >= 200 && x.status < 300)) {
                console.error(
                    `  - ${r.status} replica=${r.replicaId} body=${JSON.stringify(r.body)}`
                )
            }
            throw new Error(`iter ${iteration} group ${g}: ${slot.ok} successes`)
        }
        if (slot.other.length > 0) {
            for (const r of slot.other.slice(0, 5)) {
                console.error(
                    `[purchase] iter=${iteration} group=${g} unexpected ${r.status} body=${JSON.stringify(r.body)}`
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
        `[purchase] server=${SERVER_URL} groups=${CUSTOMER_GROUPS} purchases/group=${PURCHASES_PER_GROUP} inner=${INNER_ITERATIONS}`
    )

    const { movieId, theaterId } = await setupMovieTheater()
    const customers = await Promise.all(
        Array.from({ length: CUSTOMER_GROUPS }, (_, i) => createAndLoginCustomer(i))
    )

    const spacingMs = 3 * 60 * 60 * 1000

    for (let i = 1; i <= INNER_ITERATIONS; i++) {
        const result = await runInner(i, movieId, theaterId, customers, i * spacingMs)
        console.log(
            `[purchase] iter ${i}/${INNER_ITERATIONS} OK — ${result.total} reqs, ${result.replicas} replicas`
        )
    }

    console.log(
        `[purchase] PASS: ${INNER_ITERATIONS} iters × ${CUSTOMER_GROUPS} groups × ${PURCHASES_PER_GROUP} purchases`
    )
}

main().catch((err) => {
    console.error('[purchase] error:', err)
    process.exit(1)
})
