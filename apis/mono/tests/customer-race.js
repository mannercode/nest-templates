// Distributed stress test: customer email uniqueness under heavy parallel
// contention.
//
// Each inner iteration: EMAIL_GROUPS distinct emails, each attacked by
// CLIENTS_PER_GROUP concurrent POSTs to /customers. All groups fire at
// once so nginx sees EMAIL_GROUPS × CLIENTS_PER_GROUP concurrent requests
// across replicas. Per group: exactly 1 × 201, rest × 409; no 5xx.
//
// Fails if: any group doesn't have exactly 1×201, any 5xx or other
// unexpected status, or responses all landed on one replica.

const http = require('http')

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000'
const EMAIL_GROUPS = Number(process.env.RACE_EMAIL_GROUPS || 10)
const CLIENTS_PER_GROUP = Number(process.env.RACE_CLIENT_COUNT || 50)
const INNER_ITERATIONS = Number(process.env.INNER_ITERATIONS || 30)

function post(path, body) {
    const url = new URL(path, SERVER_URL)
    const payload = JSON.stringify(body)
    const agent = new http.Agent({ keepAlive: false })

    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                agent,
                hostname: url.hostname,
                port: url.port,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'content-length': Buffer.byteLength(payload)
                }
            },
            (res) => {
                const chunks = []
                res.on('data', (c) => chunks.push(c))
                res.on('end', () => {
                    resolve({
                        status: res.statusCode,
                        replicaId: res.headers['x-replica-id'],
                        body: Buffer.concat(chunks).toString('utf8')
                    })
                    agent.destroy()
                })
            }
        )
        req.on('error', reject)
        req.write(payload)
        req.end()
    })
}

async function runInner(iteration) {
    // Build EMAIL_GROUPS × CLIENTS_PER_GROUP requests, all fired together.
    const emails = Array.from(
        { length: EMAIL_GROUPS },
        (_, g) => `race.${Date.now()}.${iteration}.${g}.${Math.random().toString(36).slice(2)}@example.com`
    )

    const requests = emails.flatMap((email) =>
        Array.from({ length: CLIENTS_PER_GROUP }, () =>
            post('/customers', {
                name: 'race',
                birthDate: '1990-01-01T00:00:00.000Z',
                email,
                password: 'racepassword'
            }).then((r) => ({ ...r, email }))
        )
    )

    const results = await Promise.all(requests)

    // Aggregate per email.
    const byEmail = new Map()
    const replicaSet = new Set()
    for (const r of results) {
        const g = byEmail.get(r.email) ?? { created: 0, conflict: 0, other: [] }
        if (r.status === 201) g.created++
        else if (r.status === 409) g.conflict++
        else g.other.push(r)
        byEmail.set(r.email, g)
        if (r.replicaId) replicaSet.add(r.replicaId)
    }

    for (const [email, g] of byEmail) {
        if (g.created !== 1) {
            console.error(
                `[race] iter=${iteration} email=${email}: expected 1 × 201, got ${g.created}`
            )
            throw new Error(`iter ${iteration}: email ${email} had ${g.created} × 201`)
        }
        if (g.other.length > 0) {
            for (const r of g.other.slice(0, 5)) {
                console.error(
                    `[race] iter=${iteration} email=${email} unexpected ${r.status} replica=${r.replicaId}`
                )
            }
            throw new Error(`iter ${iteration}: email ${email} had ${g.other.length} unexpected`)
        }
    }

    if (replicaSet.size < 2) {
        throw new Error(
            `iter ${iteration}: only 1 replica served (got ${[...replicaSet]}) — cross-replica unverified`
        )
    }

    return { groups: EMAIL_GROUPS, total: results.length, replicas: replicaSet.size }
}

async function main() {
    console.log(
        `[race] server=${SERVER_URL} groups=${EMAIL_GROUPS} clients/group=${CLIENTS_PER_GROUP} inner=${INNER_ITERATIONS}`
    )

    for (let i = 1; i <= INNER_ITERATIONS; i++) {
        const result = await runInner(i)
        console.log(
            `[race] iter ${i}/${INNER_ITERATIONS} OK — ${result.groups} groups × ${CLIENTS_PER_GROUP} clients (${result.total} reqs, ${result.replicas} replicas)`
        )
    }

    console.log(
        `[race] PASS: ${INNER_ITERATIONS} iters × ${EMAIL_GROUPS} groups × ${CLIENTS_PER_GROUP} clients`
    )
}

main().catch((err) => {
    console.error('[race] error:', err)
    process.exit(1)
})
