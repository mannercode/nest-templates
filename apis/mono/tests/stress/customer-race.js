// Distributed stress test: customer email uniqueness under concurrent
// creates across replicas.
//
// Fires N concurrent POST /customers with the same email via nginx. Each
// request uses a fresh http.Agent so nginx (least_conn) distributes them
// across replicas. With the service layer catching Mongo's duplicate-key
// error and translating to 409, exactly one request must succeed with 201
// and the rest must return 409 — never 500 and never two successes.
//
// Fails if: no 201, more than one 201, any 500, or the responses came from
// a single replica (no cross-replica coverage).

const http = require('http')

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000'
const CLIENT_COUNT = Number(process.env.RACE_CLIENT_COUNT || 20)

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

async function main() {
    const email = `race.${Date.now()}.${Math.random().toString(36).slice(2)}@example.com`
    console.log(`[race] server=${SERVER_URL} clients=${CLIENT_COUNT} email=${email}`)

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

    console.log(
        `[race] statuses=${JSON.stringify(Object.fromEntries(byStatus))} replicas=${replicaSet.size}`
    )

    const created = byStatus.get(201) || 0
    const conflicts = byStatus.get(409) || 0
    const other = CLIENT_COUNT - created - conflicts

    if (created !== 1) {
        console.error(`[race] expected exactly 1 created, got ${created}`)
        for (const r of results) console.error(`  - ${r.status} replica=${r.replicaId}`)
        process.exit(1)
    }
    if (other !== 0) {
        console.error(`[race] unexpected non-201/409 responses: ${other}`)
        for (const r of results.filter((x) => x.status !== 201 && x.status !== 409)) {
            console.error(`  - ${r.status} replica=${r.replicaId} body=${r.body}`)
        }
        process.exit(1)
    }
    if (replicaSet.size < 2) {
        console.error(
            `[race] only 1 replica served the race (got ${[...replicaSet]}) — cross-replica unverified`
        )
        process.exit(1)
    }

    console.log(
        `[race] PASS: 1×201, ${conflicts}×409 across ${replicaSet.size} replicas`
    )
}

main().catch((err) => {
    console.error('[race] error:', err)
    process.exit(1)
})
