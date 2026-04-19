import type { INestApplication } from '@nestjs/common'
import { AppLoggerService, PathUtil } from '@mannercode/common'
import { Transport, MicroserviceOptions } from '@nestjs/microservices'
import compression from 'compression'
import express from 'express'
import { exit } from 'process'
import { AppConfigService } from './config/app-config.service'

type ConfigureAppOptions = { app: INestApplication<any>; natsOptions: { queue: string } }

export async function configureApp({ app, natsOptions }: ConfigureAppOptions) {
    const { http, log, nats } = app.get(AppConfigService)

    await PathUtil.mkdir(log.directory)

    if (!(await PathUtil.isWritable(log.directory))) {
        console.error(`Error: Directory is not writable: '${log.directory}'`)
        exit(1)
    }

    app.use(compression())
    app.use(express.json({ limit: http.requestPayloadLimit }))

    app.connectMicroservice<MicroserviceOptions>(
        { options: { servers: nats.servers, ...natsOptions }, transport: Transport.NATS },
        { inheritAppConfig: true }
    )

    await app.startAllMicroservices()

    const logger = app.get(AppLoggerService)
    app.useLogger(logger)

    app.enableShutdownHooks()

    await app.listen(http.port)
}
