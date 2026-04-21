import {
    CacheService,
    getByPath,
    InjectCache,
    JsonUtil,
    newObjectIdString
} from '@mannercode/common'
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq'
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { Job, Queue } from 'bullmq'
import { ShowtimesService, TicketsService } from 'cores'
import { BulkCreateShowtimesDto } from '../dtos'
import { ShowtimeCreationEvents } from '../showtime-creation.events'
import { ShowtimeBulkCreatorService } from './showtime-bulk-creator.service'
import { ShowtimeBulkValidatorService } from './showtime-bulk-validator.service'
import { ShowtimeCreationJobData, ShowtimeCreationStatus } from './types'

const VALIDATE_CREATE_LOCK_KEY = 'validate-and-create'
const VALIDATE_CREATE_LOCK_TTL_MS = 5 * 60 * 1000
const VALIDATE_CREATE_LOCK_WAIT_MS = 10 * 60 * 1000

@Injectable()
@Processor('showtime-creation')
export class ShowtimeCreationWorkerService
    extends WorkerHost
    implements OnModuleDestroy, OnModuleInit
{
    private readonly logger = new Logger(ShowtimeCreationWorkerService.name)

    constructor(
        private readonly validatorService: ShowtimeBulkValidatorService,
        private readonly creatorService: ShowtimeBulkCreatorService,
        private readonly events: ShowtimeCreationEvents,
        private readonly showtimesService: ShowtimesService,
        private readonly ticketsService: TicketsService,
        @InjectCache('showtime-creation') private readonly cache: CacheService,
        @InjectQueue('showtime-creation') private readonly queue: Queue
    ) {
        super()
    }

    async enqueueShowtimeCreationJob(createDto: BulkCreateShowtimesDto) {
        const sagaId = newObjectIdString()

        this.logger.log('enqueueShowtimeCreationJob', { sagaId })

        const jobData: ShowtimeCreationJobData = { createDto, sagaId }

        await this.events.emitStatusChanged({ sagaId, status: ShowtimeCreationStatus.Waiting })

        await this.queue.add('showtime-creation.create', jobData)

        return sagaId
    }

    async onModuleDestroy() {
        await this.worker.close()
    }

    async onModuleInit() {
        /**
         * When Redis is offline during onModuleInit, the BullMQ initialization tasks wait in the offlineQueue.
         * In this state, if onModuleDestroy is called before Redis comes online,
         * the tasks in the offlineQueue throw an 'Error: Connection is closed' error.
         * To address this, we use waitUntilReady so that the system waits until Redis is online.
         *
         * onModuleInit에서 Redis가 오프라인이면 BullMQ 초기화 작업이 offlineQueue에 대기한다.
         * 이 상태에서 Redis가 온라인 되기 전에 onModuleDestroy가 호출되면,
         * offlineQueue의 작업들이 'Error: Connection is closed' 오류를 던진다.
         * 이를 해결하기 위해 waitUntilReady로 Redis가 온라인 될 때까지 대기한다.
         */
        await this.worker.waitUntilReady()
    }

    async process(job: Job<ShowtimeCreationJobData>) {
        try {
            this.logger.log('process start', { sagaId: job.data.sagaId })

            const jobData = JsonUtil.reviveDates(job.data)

            await this.processJobData(jobData)
        } catch (error: unknown) {
            const message = getByPath(error, 'message', String(error))

            this.logger.warn('process error, executing compensation', {
                sagaId: job.data.sagaId,
                error: message
            })

            // compensate() uses Promise.allSettled internally; it never throws,
            // so no outer catch is needed here.
            await this.compensate(job.data.sagaId)

            await this.events.emitStatusChanged({
                message,
                sagaId: job.data.sagaId,
                status: ShowtimeCreationStatus.Error
            })
        }
    }

    private async compensate(sagaId: string) {
        const targets = ['tickets', 'showtimes'] as const
        const results = await Promise.allSettled([
            this.ticketsService.deleteBySagaIds([sagaId]),
            this.showtimesService.deleteBySagaIds([sagaId])
        ])

        this.logger.log('compensate completed', {
            sagaId,
            results: results.map((r, i) => ({
                target: targets[i],
                status: r.status,
                reason: getByPath(r, 'reason.message', getByPath(r, 'reason', undefined))
            }))
        })
    }

    private async processJobData({ createDto, sagaId }: ShowtimeCreationJobData) {
        await this.events.emitStatusChanged({ sagaId, status: ShowtimeCreationStatus.Processing })

        // Validate-then-insert is a read-modify-write on the showtimes
        // collection. With one BullMQ worker per replica, two overlapping
        // sagas can both pass validation before either commits. A cross-
        // replica lock serializes the (validate, create) pair so exactly
        // one saga sees a conflicting showtime whenever another has
        // already inserted.
        await this.cache.withLockBlocking(
            VALIDATE_CREATE_LOCK_KEY,
            VALIDATE_CREATE_LOCK_TTL_MS,
            async () => {
                const { conflictingShowtimes, isValid } =
                    await this.validatorService.validate(createDto)

                if (isValid) {
                    const creationResult = await this.creatorService.create(createDto, sagaId)

                    await this.events.emitStatusChanged({
                        sagaId,
                        status: ShowtimeCreationStatus.Succeeded,
                        ...creationResult
                    })
                } else {
                    await this.events.emitStatusChanged({
                        conflictingShowtimes,
                        sagaId,
                        status: ShowtimeCreationStatus.Failed
                    })
                }
            },
            { waitMs: VALIDATE_CREATE_LOCK_WAIT_MS }
        )
    }
}
