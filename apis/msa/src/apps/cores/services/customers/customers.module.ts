import { JwtAuthModule, TimeUtil } from '@mannercode/common'
import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { AppConfigService, getProjectId, MongooseConfigModule, RedisConfigModule } from 'config'
import { CustomersHttpController } from './customers.http-controller'
import { CustomersRepository } from './customers.repository'
import { CustomersService } from './customers.service'
import {
    CustomerJwtAuthGuard,
    CustomerLocalAuthGuard,
    CustomerOptionalJwtAuthGuard
} from './guards'
import { Customer, CustomerSchema } from './models'
import { CustomerAuthenticationService } from './services'

@Module({
    controllers: [CustomersHttpController],
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
    providers: [
        CustomersService,
        CustomerAuthenticationService,
        CustomersRepository,
        CustomerJwtAuthGuard,
        CustomerLocalAuthGuard,
        CustomerOptionalJwtAuthGuard
    ],
    exports: [CustomerJwtAuthGuard, CustomerOptionalJwtAuthGuard]
})
export class CustomersModule {}
