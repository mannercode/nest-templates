import { InjectPubSub, JsonUtil, PubSubService } from '@mannercode/common'
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { Observable, Subject } from 'rxjs'
import type { ShowtimeCreationEvent } from './services/types'

/**
 * Bridges worker → SSE client across replicas.
 *
 * The worker that processes a job may live on a different replica than the
 * HTTP controller serving an SSE stream. We publish status changes onto a
 * Redis pub/sub channel and subscribe on every replica, forwarding incoming
 * messages to a local RxJS Subject. `observeStatusChanged` exposes that
 * Subject so the controller can map events into SSE payloads.
 */
@Injectable()
export class ShowtimeCreationEvents implements OnModuleInit, OnModuleDestroy {
    private static readonly CHANNEL = 'showtime-creation.statusChanged'

    private readonly subject = new Subject<ShowtimeCreationEvent>()
    private readonly handler = (message: string) => {
        const event = JsonUtil.parse(message) as ShowtimeCreationEvent
        this.subject.next(event)
    }

    constructor(@InjectPubSub() private readonly pubSub: PubSubService) {}

    async onModuleInit() {
        await this.pubSub.subscribe(ShowtimeCreationEvents.CHANNEL, this.handler)
    }

    async onModuleDestroy() {
        await this.pubSub.unsubscribe(ShowtimeCreationEvents.CHANNEL, this.handler)
        this.subject.complete()
    }

    async emitStatusChanged(payload: ShowtimeCreationEvent) {
        await this.pubSub.publish(ShowtimeCreationEvents.CHANNEL, JSON.stringify(payload))
    }

    observeStatusChanged(): Observable<ShowtimeCreationEvent> {
        return this.subject.asObservable()
    }
}
