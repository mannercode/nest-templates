import type { CacheServiceFixture } from './cache.service.fixture'
import { sleep } from '../../utils'

describe('CacheService', () => {
    let fix: CacheServiceFixture

    beforeEach(async () => {
        const { createCacheServiceFixture } = await import('./cache.service.fixture')
        fix = await createCacheServiceFixture()
    })
    afterEach(() => fix.teardown())

    describe('set', () => {
        // TTL이 제공되지 않을 때
        describe('when the TTL is not provided', () => {
            // 값을 저장한다
            it('stores the value', async () => {
                await fix.cacheService.set('key', 'value')
                const cachedValue = await fix.cacheService.get('key')
                expect(cachedValue).toEqual('value')
            })
        })

        // TTL이 제공될 때
        describe('when a TTL is provided', () => {
            let ttl: number

            beforeEach(() => {
                ttl = 1000
            })

            // TTL 이후에 만료된다
            it('expires after the TTL', async () => {
                await fix.cacheService.set('key', 'value', ttl)

                const beforeExpiration = await fix.cacheService.get('key')
                expect(beforeExpiration).toEqual('value')

                await sleep(ttl * 1.1)

                const afterExpiration = await fix.cacheService.get('key')
                expect(afterExpiration).toBeNull()
            })
        })

        // TTL이 0일 때
        describe('when the TTL is 0', () => {
            let ttl: number

            beforeEach(() => {
                ttl = 0
            })

            // 만료되지 않는다
            it('does not expire', async () => {
                await fix.cacheService.set('key', 'value', ttl)

                const beforeExpiration = await fix.cacheService.get('key')
                expect(beforeExpiration).toEqual('value')

                await sleep(1000)

                const afterExpiration = await fix.cacheService.get('key')
                expect(afterExpiration).toEqual('value')
            })
        })

        // TTL이 음수일 때
        describe('when the TTL is negative', () => {
            let invalidTtl: number

            beforeEach(() => {
                invalidTtl = -100
            })

            // 예외를 던진다
            it('throws', async () => {
                await expect(fix.cacheService.set('key', 'value', invalidTtl)).rejects.toThrow(
                    'TTL must be a non-negative integer (0 for no expiration)'
                )
            })
        })
    })

    describe('delete', () => {
        // 키가 존재할 때
        describe('when the key exists', () => {
            // 캐시된 값을 삭제한다
            it('deletes the cached value', async () => {
                await fix.cacheService.set('key', 'value')

                const beforeDelete = await fix.cacheService.get('key')
                expect(beforeDelete).toEqual('value')

                await fix.cacheService.delete('key')

                const afterDelete = await fix.cacheService.get('key')
                expect(afterDelete).toBeNull()
            })
        })
    })

    describe('executeScript', () => {
        // 스크립트를 실행하고 결과를 반환한다
        it('runs the script and returns the result', async () => {
            const script = `return redis.call('SET', KEYS[1], ARGV[2])`
            const keys = ['key']
            const args = ['value']

            const result = await fix.cacheService.executeScript(script, keys, args)
            expect(result).toBe('OK')

            const storedValue = await fix.cacheService.get('key')
            expect(storedValue).toBe('value')
        })
    })

    describe('withLock', () => {
        // 락을 점유한 중에는 다른 호출이 fn 을 실행하지 않는다
        it('allows only one concurrent runner per key', async () => {
            let running = 0
            let maxConcurrent = 0
            let executedCount = 0

            const runners = Array.from({ length: 20 }, () =>
                fix.cacheService.withLock('job', 5_000, async () => {
                    running += 1
                    maxConcurrent = Math.max(maxConcurrent, running)
                    executedCount += 1
                    await sleep(20)
                    running -= 1
                })
            )

            const results = await Promise.all(runners)

            expect(maxConcurrent).toBe(1)
            expect(executedCount).toBe(results.filter((r) => r.ran).length)
            expect(results.filter((r) => r.ran)).toHaveLength(executedCount)
            expect(executedCount).toBeGreaterThanOrEqual(1)
        }, 30_000)

        // 락 보유자만 해제할 수 있어야 한다 (만료 후 다른 runner 의 락은 안 지운다)
        it('releases only the lock it acquired', async () => {
            await fix.cacheService.set('lock:job', 'other-runner', 10_000)

            const result = await fix.cacheService.withLock('job', 5_000, async () => {
                throw new Error('should not run while another owner holds lock')
            })

            expect(result.ran).toBe(false)
            // 락 값이 바뀌지 않았는지 확인
            const value = await fix.cacheService.get('lock:job')
            expect(value).toBe('other-runner')
        })

        // TTL 이 0 이하이면 예외를 던진다
        it('throws when TTL is zero or negative', async () => {
            await expect(fix.cacheService.withLock('job', 0, async () => null)).rejects.toThrow(
                'Lock TTL must be a positive integer (ms)'
            )
            await expect(fix.cacheService.withLock('job', -1, async () => null)).rejects.toThrow(
                'Lock TTL must be a positive integer (ms)'
            )
        })

        // fn 이 예외를 던져도 락을 해제한다
        it('releases the lock even when fn throws', async () => {
            await expect(
                fix.cacheService.withLock('job', 5_000, () => {
                    throw new Error('boom')
                })
            ).rejects.toThrow('boom')

            // 바로 다음 호출이 fn 을 실행할 수 있어야 한다
            const next = await fix.cacheService.withLock('job', 5_000, async () => 'ok')
            expect(next).toEqual({ ran: true, result: 'ok' })
        })
    })

    describe('withLockBlocking', () => {
        // 경쟁이 없을 때 즉시 실행된다
        it('runs immediately when uncontended', async () => {
            const result = await fix.cacheService.withLockBlocking('job', 5_000, async () => 42)
            expect(result).toBe(42)
        })

        // 동시 호출은 직렬화되어 모두 실행된다
        it('serializes concurrent callers so every fn runs once', async () => {
            let running = 0
            let maxConcurrent = 0
            const runnerCount = 10

            const runners = Array.from({ length: runnerCount }, (_, i) =>
                fix.cacheService.withLockBlocking(
                    'job',
                    5_000,
                    async () => {
                        running += 1
                        maxConcurrent = Math.max(maxConcurrent, running)
                        await sleep(20)
                        running -= 1
                        return i
                    },
                    { pollMs: 10 }
                )
            )

            const results = await Promise.all(runners)
            expect(results).toHaveLength(runnerCount)
            expect(new Set(results).size).toBe(runnerCount)
            expect(maxConcurrent).toBe(1)
        }, 30_000)

        // 대기 시간 안에 락을 못 잡으면 예외를 던진다
        it('throws when the lock cannot be acquired before the wait deadline', async () => {
            // 다른 보유자가 오래 잡고 있는 상황을 흉내
            await fix.cacheService.set('lock:job', 'other', 10_000)

            await expect(
                fix.cacheService.withLockBlocking('job', 5_000, async () => 'unused', {
                    pollMs: 10,
                    waitMs: 50
                })
            ).rejects.toThrow(/could not acquire 'job'/)
        })
    })
})
