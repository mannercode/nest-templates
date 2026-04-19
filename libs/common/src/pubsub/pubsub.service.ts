import {
    DynamicModule,
    Inject,
    Injectable,
    Module,
    OnModuleDestroy,
    OnModuleInit
} from '@nestjs/common'
import { getRedisConnectionToken, RedisConnection } from '../redis'
import { defaultTo } from '../utils'

type MessageHandler = (message: string) => void

/**
 * Redis-backed pub/sub that fans messages out across processes / replicas.
 *
 * Single ioredis connections that SUBSCRIBE cannot issue other commands, so
 * PubSubService keeps a separate duplicate connection for subscribe state and
 * uses the injected one for publish. Handlers are invoked in the order they
 * were registered; an exception in one handler does not prevent later
 * handlers from running.
 */
@Injectable()
export class PubSubService implements OnModuleInit, OnModuleDestroy {
    private subscriber!: RedisConnection
    private readonly handlers = new Map<string, Set<MessageHandler>>()

    constructor(private readonly publisher: RedisConnection) {}

    static getName(name?: string) {
        return `PubSubService_${defaultTo(name, 'default')}`
    }

    async onModuleInit() {
        // `duplicate` returns a new connection with the same config; the clone
        // is what we put into subscribe mode so the caller's publisher stays
        // usable for other commands.
        this.subscriber = this.publisher.duplicate()

        this.subscriber.on('message', (channel: string, message: string) => {
            const handlers = this.handlers.get(channel)
            if (!handlers) return

            // 한 handler 의 throw 가 다른 handler 전달을 막지 않도록 각각 격리
            for (const handler of handlers) {
                try {
                    handler(message)
                } catch {
                    /* swallow — handler is responsible for its own error reporting */
                }
            }
        })
    }

    async onModuleDestroy() {
        await this.subscriber.quit()
    }

    async publish(channel: string, message: string): Promise<void> {
        await this.publisher.publish(channel, message)
    }

    async subscribe(channel: string, handler: MessageHandler): Promise<void> {
        let handlers = this.handlers.get(channel)
        const firstHandlerForChannel = !handlers
        if (!handlers) {
            handlers = new Set()
            this.handlers.set(channel, handlers)
        }
        handlers.add(handler)

        // Only the first subscriber for a channel issues SUBSCRIBE; subsequent
        // handlers piggy-back on the same Redis subscription. Awaiting the ack
        // ensures callers can publish right after and trust delivery.
        if (firstHandlerForChannel) {
            await this.subscriber.subscribe(channel)
        }
    }

    async unsubscribe(channel: string, handler: MessageHandler): Promise<void> {
        const handlers = this.handlers.get(channel)
        if (!handlers) return

        handlers.delete(handler)
        if (handlers.size === 0) {
            this.handlers.delete(channel)
            await this.subscriber.unsubscribe(channel)
        }
    }
}

export type PubSubModuleOptions = { name?: string; redisName?: string }

export function InjectPubSub(name?: string): ParameterDecorator {
    return Inject(PubSubService.getName(name))
}

@Module({})
export class PubSubModule {
    static register(options: PubSubModuleOptions = {}): DynamicModule {
        const { name, redisName } = options

        const provider = {
            inject: [getRedisConnectionToken(redisName)],
            provide: PubSubService.getName(name),
            useFactory: (redis: RedisConnection) => new PubSubService(redis)
        }

        return { exports: [provider], module: PubSubModule, providers: [provider] }
    }
}
