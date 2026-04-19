import type { PubSubServiceFixture } from './pubsub.service.fixture'

describe('PubSubService', () => {
    let fix: PubSubServiceFixture
    const channel = 'test-channel'

    beforeEach(async () => {
        const { createPubSubServiceFixture } = await import('./pubsub.service.fixture')
        fix = await createPubSubServiceFixture()
    })
    afterEach(() => fix.teardown())

    // 두 replica 가 같은 Redis 를 공유할 때 한쪽 publish 가 다른 쪽 subscriber 에 도달한다
    it('delivers messages from one replica to another', async () => {
        const received: string[] = []
        await fix.pubSubB.subscribe(channel, (msg) => received.push(msg))

        await fix.pubSubA.publish(channel, 'hello')

        await waitFor(() => received.length > 0)
        expect(received).toEqual(['hello'])
    })

    // 한 channel 에 여러 subscriber 가 있을 때 모두 메시지를 받는다
    it('fans messages out to multiple handlers on the same channel', async () => {
        const received1: string[] = []
        const received2: string[] = []

        await fix.pubSubB.subscribe(channel, (msg) => received1.push(msg))
        await fix.pubSubB.subscribe(channel, (msg) => received2.push(msg))

        await fix.pubSubA.publish(channel, 'payload')

        await waitFor(() => received1.length > 0 && received2.length > 0)

        expect(received1).toEqual(['payload'])
        expect(received2).toEqual(['payload'])
    })

    // unsubscribe 후에는 해당 handler 에 메시지가 오지 않는다
    it('stops delivering to a handler after it unsubscribes', async () => {
        const received: string[] = []
        const handler = (msg: string) => received.push(msg)

        await fix.pubSubB.subscribe(channel, handler)

        await fix.pubSubA.publish(channel, 'before-unsub')
        await waitFor(() => received.length > 0)

        await fix.pubSubB.unsubscribe(channel, handler)

        await fix.pubSubA.publish(channel, 'after-unsub')
        // 후속 메시지가 안 오는지 잠깐 기다려 검증
        await new Promise((r) => setTimeout(r, 50))

        expect(received).toEqual(['before-unsub'])
    })

    // handler 가 throw 해도 다른 handler 에 메시지가 전달된다
    it('isolates failures in one handler from another', async () => {
        const received: string[] = []
        await fix.pubSubB.subscribe(channel, () => {
            throw new Error('boom')
        })
        await fix.pubSubB.subscribe(channel, (msg) => received.push(msg))

        await fix.pubSubA.publish(channel, 'payload')

        await waitFor(() => received.length > 0)
        expect(received).toEqual(['payload'])
    })

    // 구독한 적 없는 channel 에 대한 unsubscribe 는 no-op 이어야 한다
    it('no-ops unsubscribe on an unknown channel', async () => {
        await expect(fix.pubSubB.unsubscribe('never-subscribed', () => {})).resolves.toBeUndefined()
    })

    // 여러 handler 중 하나만 제거해도 Redis 구독은 유지된다
    it('keeps the Redis subscription alive while other handlers remain', async () => {
        const received: string[] = []
        const firstHandler = () => {}
        const secondHandler = (msg: string) => received.push(msg)

        await fix.pubSubB.subscribe(channel, firstHandler)
        await fix.pubSubB.subscribe(channel, secondHandler)

        await fix.pubSubB.unsubscribe(channel, firstHandler)

        await fix.pubSubA.publish(channel, 'still-listening')
        await waitFor(() => received.length > 0)
        expect(received).toEqual(['still-listening'])
    })

    // Redis 가 local handler 가 없는 channel 메시지를 전달해도 (unsubscribe 레이스) throw 하지 않는다
    it('ignores messages for channels with no local handlers', () => {
        const subscriber = (
            fix.pubSubB as unknown as { subscriber: { emit: (...args: unknown[]) => boolean } }
        ).subscriber
        expect(() => subscriber.emit('message', 'no-local-handlers', 'stray')).not.toThrow()
    })
})

describe('InjectPubSub', () => {
    // decorator factory 가 parameter decorator 를 반환한다 (기본 이름)
    it('returns a parameter decorator using the default name', async () => {
        const { InjectPubSub } = await import('../pubsub.service')
        expect(typeof InjectPubSub()).toBe('function')
    })

    // decorator factory 가 parameter decorator 를 반환한다 (명명된 인스턴스)
    it('returns a parameter decorator for a named PubSubService', async () => {
        const { InjectPubSub } = await import('../pubsub.service')
        expect(typeof InjectPubSub('my-bus')).toBe('function')
    })
})

describe('PubSubModule.register', () => {
    // 기본 옵션으로도 DynamicModule 을 만들 수 있다
    it('builds a module with defaults', async () => {
        const { PubSubModule } = await import('../pubsub.service')
        const mod = PubSubModule.register()
        expect(mod.providers).toHaveLength(1)
        expect(mod.exports).toHaveLength(1)
    })
})

async function waitFor(
    predicate: () => boolean,
    { timeoutMs = 2000, intervalMs = 10 } = {}
): Promise<void> {
    const start = Date.now()
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
        await new Promise((r) => setTimeout(r, intervalMs))
    }
}
