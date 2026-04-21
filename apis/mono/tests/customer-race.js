// Distributed stress test: customer email uniqueness under concurrent
// creates across replicas.
//
// Fires N concurrent POST /customers with the same email via nginx. Each
// request uses a fresh http.Agent so nginx (least_conn) distributes them
// across replicas. With the service layer catching Mongo's duplicate-key
// error and translating to 409, exactly one request must succeed with 201
// and the rest must return 409 — never 500 and never two successes.
//
// Each outer runner invocation repeats the race INNER_ITERATIONS times
// against the same compose stack (new email per iter) to widen contention
// coverage without paying compose-up cost per race.
//
// Fails if: no 201, more than one 201, any 500, or the responses came from
// a single replica (no cross-replica coverage).

const http = require('http')

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000'
const CLIENT_COUNT = Number(process.env.RACE_CLIENT_COUNT || 50)
const INNER_ITERATIONS = Number(process.env.INNER_ITERATIONS || 5)

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

async function runOnce(iteration) {
    const email = `race.${Date.now()}.${iteration}.${Math.random().toString(36).slice(2)}@example.com`

    const results = await Promise.all(
        Array.from({ length: CLIENT_COUNT }, () =>
            post('/customers', {
                name: 'race',
                birthDate: '1990-01-01T00:00:00.000Z',
                email,
                password: 'racepassword'
            })
        )
    )

    const byStatus = new Map()
    const replicaSet = new Set()
    for (const r of results) {
        byStatus.set(r.status, (byStatus.get(r.status) || 0) + 1)
        if (r.replicaId) replicaSet.add(r.replicaId)
    }

    const created = byStatus.get(201) || 0
    const conflicts = byStatus.get(409) || 0
    const other = CLIENT_COUNT - created - conflicts

    if (created !== 1) {
        console.error(`[race] iter=${iteration} expected exactly 1 created, got ${created}`)
        for (const r of results) console.error(`  - ${r.status} replica=${r.replicaId}`)
        throw new Error(`iter ${iteration} expected 1 created, got ${created}`)
    }
    if (other !== 0) {
        console.error(`[race] iter=${iteration} unexpected non-201/409: ${other}`)
        for (const r of results.filter((x) => x.status !== 201 && x.status !== 409)) {
            console.error(`  - ${r.status} replica=${r.replicaId} body=${r.body}`)
        }
        throw new Error(`iter ${iteration} unexpected statuses`)
    }
    if (replicaSet.size < 2) {
        throw new Error(
            `iter ${iteration}: only 1 replica served (got ${[...replicaSet]}) — cross-replica unverified`
        )
    }

    return { conflicts, replicas: replicaSet.size }
}

async function main() {
    console.log(
        `[race] server=${SERVER_URL} clients=${CLIENT_COUNT} inner=${INNER_ITERATIONS}`
    )

    for (let i = 1; i <= INNER_ITERATIONS; i++) {
        const result = await runOnce(i)
        console.log(
            `[race] iter ${i}/${INNER_ITERATIONS} OK — 1×201, ${result.conflicts}×409, ${result.replicas} replicas`
        )
    }

    console.log(`[race] PASS: ${INNER_ITERATIONS} iterations × ${CLIENT_COUNT} clients`)
}

main().catch((err) => {
    console.error('[race] error:', err)
    process.exit(1)
})
