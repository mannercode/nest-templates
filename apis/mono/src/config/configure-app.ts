import type { INestApplication } from '@nestjs/common'
import { AppLoggerService, PathUtil } from '@mannercode/common'
import compression from 'compression'
import express from 'express'
import { hostname } from 'os'
import { exit } from 'process'
import { AppConfigService } from './config/app-config.service'

type ConfigureAppOptions = { app: INestApplication<any> }

export async function configureApp({ app }: ConfigureAppOptions) {
    const { http, log } = app.get(AppConfigService)

    await PathUtil.mkdir(log.directory)

    if (!(await PathUtil.isWritable(log.directory))) {
        console.error(`Error: Directory is not writable: '${log.directory}'`)
        exit(1)
    }

    // Replica identifier for distributed stress tests. In docker the hostname
    // is the container id, which is unique per replica. The value is safe to
    // expose — it's the same information visible in docker ps / nginx upstream.
    const replicaId = hostname()
    app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
        res.setHeader('x-replica-id', replicaId)
        next()
    })

    app.use(compression())
    app.use(express.json({ limit: http.requestPayloadLimit }))

    const logger = app.get(AppLoggerService)
    app.useLogger(logger)

    app.enableShutdownHooks()

    const server = await app.listen(http.port)
    // Keep idle upstream connections alive longer than nginx's pool timeout
    // (default 60s) so nginx never tries to reuse a connection Node has
    // already closed — which would surface to clients as a 502.
    server.keepAliveTimeout = 65_000
    server.headersTimeout = 66_000
}
