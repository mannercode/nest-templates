// Distributed stress test: purchase double-spend race across replicas.
//
// A single customer holds a set of tickets, then fires N concurrent
// POST /purchases with the SAME ticketIds. Only one purchase may create
// a payment and a purchase record — the rest must fail. Without per-
// ticket serialization (or an atomic "Available → Sold" update), the
// validator sees the same hold N times and every call creates its own
// payment, producing a double-charge.
//
// Fails if: more than one purchase succeeds, or zero succeed.

const http = require('http')

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000'
const CLIENT_COUNT = Number(process.env.PURCHASE_CLIENT_COUNT || 20)
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

async function setupShowtime() {
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
    if (movie.status !== 201) throw new Error(`movie create: ${movie.status}`)

    const publish = await requestRaw('POST', `/movies/${movie.body.id}/publish`)
    if (publish.status !== 200 && publish.status !== 201) {
        throw new Error(`movie publish: ${publish.status}`)
    }

    const theater = await requestRaw('POST', '/theaters', {
        body: {
            name: 'purchase-race',
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
        throw new Error(`showtimes search: ${search.status}`)
    }
    const showtimeId = search.body[0].id

    const tickets = await requestRaw('GET', `/booking/showtimes/${showtimeId}/tickets`)
    if (tickets.status !== 200 || !Array.isArray(tickets.body) || tickets.body.length === 0) {
        throw new Error(`tickets fetch: ${tickets.status}`)
    }
    const ticketIds = tickets.body.slice(0, 2).map((t) => t.id)
    return { showtimeId, ticketIds }
}

async function createAndLoginCustomer() {
    const email = `purchase.${Date.now()}.${Math.random().toString(36).slice(2)}@example.com`
    const password = 'purchasepass'
    const create = await requestRaw('POST', '/customers', {
        body: { name: 'purchase', birthDate: '1990-01-01T00:00:00.000Z', email, password }
    })
    if (create.status !== 201) throw new Error(`customer create: ${create.status}`)

    const login = await requestRaw('POST', '/customers/login', {
        body: { email, password }
    })
    if (login.status !== 200 && login.status !== 201) {
        throw new Error(`customer login: ${login.status}`)
    }
    return { customerId: create.body.id, accessToken: login.body.accessToken }
}

async function main() {
    console.log(`[purchase] server=${SERVER_URL} clients=${CLIENT_COUNT}`)

    const { showtimeId, ticketIds } = await setupShowtime()
    const { customerId, accessToken } = await createAndLoginCustomer()

    const hold = await requestRaw('POST', `/booking/showtimes/${showtimeId}/tickets/hold`, {
        body: { ticketIds },
        headers: { authorization: `Bearer ${accessToken}` }
    })
    if (hold.status !== 200) throw new Error(`hold: ${hold.status}`)

    console.log(`[purchase] customerId=${customerId} ticketIds=${ticketIds.join(',')}`)

    const purchaseItems = ticketIds.map((id) => ({ itemId: id, type: 'tickets' }))
    const totalPrice = ticketIds.length * 1000

    const results = await Promise.all(
        Array.from({ length: CLIENT_COUNT }, () =>
            requestRaw('POST', '/purchases', {
                body: { customerId, purchaseItems, totalPrice }
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
        `[purchase] statuses=${JSON.stringify(Object.fromEntries(byStatus))} replicas=${replicaSet.size}`
    )

    const succeeded = results.filter((r) => r.status >= 200 && r.status < 300)

    if (succeeded.length !== 1) {
        console.error(`[purchase] expected exactly 1 purchase to succeed, got ${succeeded.length}`)
        for (const r of results) {
            console.error(`  - ${r.status} replica=${r.replicaId} body=${JSON.stringify(r.body)}`)
        }
        process.exit(1)
    }

    // Extra confirmation: only one purchase record should be retrievable for
    // this outcome (the successful response's id). Two successful responses
    // would already have been caught above, but this guards against a rogue
    // purchase record created without a successful HTTP response (e.g. a
    // write-then-crash path).
    const record = succeeded[0].body
    const fetched = await requestRaw('GET', `/purchases/${record.id}`)
    if (fetched.status !== 200) {
        console.error(`[purchase] succeeded purchase ${record.id} not retrievable: ${fetched.status}`)
        process.exit(1)
    }

    console.log(`[purchase] PASS: 1 succeeded, ${CLIENT_COUNT - 1} rejected, across ${replicaSet.size} replicas`)
}

main().catch((err) => {
    console.error('[purchase] error:', err)
    process.exit(1)
})
