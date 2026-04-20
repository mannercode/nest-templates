import { DynamicModule, Inject, Injectable, Module } from '@nestjs/common'
import Redis from 'ioredis'
import { getRedisConnectionToken } from '../redis'
import { defaultTo } from '../utils'

@Injectable()
export class CacheService {
    constructor(
        private readonly redis: Redis,
        private readonly prefix: string
    ) {}

    static getName(name?: string) {
        return `CacheService_${defaultTo(name, 'default')}`
    }

    async delete(key: string) {
        await this.redis.del(this.getKey(key))
    }

    /**
     * Runs a Lua script with namespaced keys.
     * The cache prefix is always inserted as the first ARGV value.
     */
    async executeScript<T = unknown>(
        script: string,
        keys: string[],
        scriptArgs: string[]
    ): Promise<T> {
        const result = await this.redis.eval(
            script,
            keys.length,
            ...keys.map(this.getKey.bind(this)),
            this.prefix,
            ...scriptArgs
        )
        return result as T
    }

    async get(key: string): Promise<null | string> {
        const value = await this.redis.get(this.getKey(key))
        return value
    }

    async set(key: string, value: string, ttlMs = 0) {
        if (ttlMs < 0) {
            throw new Error('TTL must be a non-negative integer (0 for no expiration)')
        }

        if (0 < ttlMs) {
            await this.redis.set(this.getKey(key), value, 'PX', ttlMs)
        } else {
            await this.redis.set(this.getKey(key), value)
        }
    }

    /**
     * Distributed lock scoped to this cache. Exactly one caller holding the
     * key runs `fn`; concurrent callers return `{ ran: false }`. The lock is
     * released when `fn` settles (even on throw); if the process dies, the
     * TTL bounds how long the key stays stuck.
     *
     * - lock key lives at `${prefix}:lock:${key}`
     * - ttlMs should be larger than the worst-case runtime of `fn`; it caps
     *   the duration a crashed process can starve others
     * - only the owner (matching token) deletes the key, so an expired lock
     *   that a peer has already re-acquired is not clobbered
     */
    async withLock<T>(
        key: string,
        ttlMs: number,
        fn: () => Promise<T> | T
    ): Promise<{ ran: false } | { ran: true; result: T }> {
        if (ttlMs <= 0) throw new Error('Lock TTL must be a positive integer (ms)')

        const token = `${process.pid}:${Date.now()}:${Math.random()}`
        const lockKey = this.getKey(`lock:${key}`)
        const acquired = await this.redis.set(lockKey, token, 'PX', ttlMs, 'NX')

        if (acquired !== 'OK') return { ran: false }

        try {
            return { ran: true, result: await fn() }
        } finally {
            await this.redis.eval(
                `
                if redis.call('get', KEYS[1]) == ARGV[1] then
                    return redis.call('del', KEYS[1])
                end
                return 0
                `,
                1,
                lockKey,
                token
            )
        }
    }

    /**
     * Blocking variant of `withLock`: polls until the lock is free, then
     * acquires it and runs `fn` exactly once. Throws if the lock cannot be
     * acquired within `waitMs`.
     *
     * Use when callers must serialize with peers (not skip on contention).
     * `pollMs` should be short enough that a released lock is picked up
     * quickly, but not so short that it hammers Redis.
     */
    async withLockBlocking<T>(
        key: string,
        ttlMs: number,
        fn: () => Promise<T> | T,
        { pollMs = 50, waitMs = 2 * 60 * 1000 }: { pollMs?: number; waitMs?: number } = {}
    ): Promise<T> {
        const deadline = Date.now() + waitMs
        for (;;) {
            const attempt = await this.withLock(key, ttlMs, fn)
            if (attempt.ran) return attempt.result
            if (Date.now() >= deadline) {
                throw new Error(`withLockBlocking: could not acquire '${key}' within ${waitMs}ms`)
            }
            await new Promise((r) => setTimeout(r, pollMs))
        }
    }

    private getKey(key: string) {
        return `${this.prefix}:${key}`
    }
}

export type CacheModuleOptions = { name?: string; prefix: string; redisName?: string }

export function InjectCache(name?: string): ParameterDecorator {
    return Inject(CacheService.getName(name))
}

@Module({})
export class CacheModule {
    static register(options: CacheModuleOptions): DynamicModule {
        const { name, prefix, redisName } = options

        const provider = {
            inject: [getRedisConnectionToken(redisName)],
            provide: CacheService.getName(name),
            useFactory: async (redis: Redis) =>
                new CacheService(redis, `${prefix}:${defaultTo(name, 'default')}`)
        }

        return { exports: [provider], module: CacheModule, providers: [provider] }
    }
}
