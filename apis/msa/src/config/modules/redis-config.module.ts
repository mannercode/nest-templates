import { RedisModuleOptions, getRedisConnectionToken, RedisModule } from '@mannercode/common'
import { Module } from '@nestjs/common'
import { AppConfigService } from '../config'

@Module({
    imports: [
        RedisModule.forRootAsync(
            {
                inject: [AppConfigService],
                useFactory: (config: AppConfigService) => {
                    const { nodes } = config.redis
                    const redisOptions: RedisModuleOptions = {
                        nodes,
                        options: {
                            // ioredis default is 16; stress bursts hitting
                            // many slots back-to-back can exhaust the budget
                            // before the local slot cache settles.
                            maxRedirections: 32,
                            retryDelayOnFailover: 200,
                            retryDelayOnClusterDown: 200,
                            slotsRefreshTimeout: 5000,
                            // Per-node TCP options. Default keepAlive=0 lets
                            // idle sockets die to NAT/firewall timeouts;
                            // reusing a silently-dead socket surfaces as
                            // "Connection is closed" during bursts.
                            redisOptions: {
                                keepAlive: 30_000,
                                connectTimeout: 10_000,
                                maxRetriesPerRequest: null
                            }
                        },
                        type: 'cluster'
                    }
                    return redisOptions
                }
            },
            RedisConfigModule.connectionName
        )
    ]
})
export class RedisConfigModule {
    static get connectionName() {
        return 'redis-connection'
    }

    static get moduleName() {
        return getRedisConnectionToken(this.connectionName)
    }
}
