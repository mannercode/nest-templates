import { createTestContext, getRedisTestConnection } from '@mannercode/testing'
import { getRedisConnectionToken, RedisConnection, RedisModule } from '../../redis'
import { PubSubModule, PubSubService } from '../pubsub.service'

export type PubSubServiceFixture = {
    pubSubA: PubSubService
    pubSubB: PubSubService
    teardown: () => Promise<void>
}

/**
 * Two PubSubService instances that share the same Redis so we can drive a
 * cross-replica scenario in tests (A publishes, B subscribes — or both do).
 */
export async function createPubSubServiceFixture(): Promise<PubSubServiceFixture> {
    const contextA = await createTestContext({
        imports: [
            RedisModule.forRoot({ type: 'single', url: getRedisTestConnection() }, 'replicaA'),
            PubSubModule.register({ name: 'replicaA', redisName: 'replicaA' })
        ]
    })

    const contextB = await createTestContext({
        imports: [
            RedisModule.forRoot({ type: 'single', url: getRedisTestConnection() }, 'replicaB'),
            PubSubModule.register({ name: 'replicaB', redisName: 'replicaB' })
        ]
    })

    const pubSubA = contextA.module.get<PubSubService>(PubSubService.getName('replicaA'))
    const pubSubB = contextB.module.get<PubSubService>(PubSubService.getName('replicaB'))

    const redisA = contextA.module.get<RedisConnection>(getRedisConnectionToken('replicaA'))
    const redisB = contextB.module.get<RedisConnection>(getRedisConnectionToken('replicaB'))

    const teardown = async () => {
        await contextA.close()
        await contextB.close()
        await redisA.quit()
        await redisB.quit()
    }

    return { pubSubA, pubSubB, teardown }
}
