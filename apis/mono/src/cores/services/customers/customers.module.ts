import { JwtAuthModule, TimeUtil } from '@mannercode/common'
import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { AppConfigService, getProjectId, MongooseConfigModule, RedisConfigModule } from 'config'
import { CustomersRepository } from './customers.repository'
import { CustomersService } from './customers.service'
import { Customer, CustomerSchema } from './models'
import { CustomerAuthenticationService } from './services'

@Module({
    exports: [CustomersService],
    imports: [
        MongooseModule.forFeature(
            [{ name: Customer.name, schema: CustomerSchema }],
            MongooseConfigModule.connectionName
        ),
        JwtAuthModule.register({
            inject: [AppConfigService],
            prefix: `jwtauth:${getProjectId()}`,
            redisName: RedisConfigModule.connectionName,
            useFactory: ({ auth }: AppConfigService) => ({
                auth: {
                    accessSecret: auth.accessSecret,
                    accessTokenTtlMs: TimeUtil.toMs(auth.accessTokenExpiration),
                    refreshSecret: auth.refreshSecret,
                    refreshTokenTtlMs: TimeUtil.toMs(auth.refreshTokenExpiration)
                }
            })
        })
    ],
    providers: [CustomersService, CustomerAuthenticationService, CustomersRepository]
})
export class CustomersModule {}
