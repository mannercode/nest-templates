import { Module } from '@nestjs/common'
import { CommonModule, MongooseConfigModule, RedisConfigModule } from 'config'
import { HealthModule } from './modules'
import { AssetsModule, PaymentsModule } from './services'

@Module({
    imports: [
        CommonModule,
        MongooseConfigModule,
        RedisConfigModule,
        HealthModule,
        PaymentsModule,
        AssetsModule
    ]
})
export class InfrastructuresModule {}
