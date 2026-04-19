import { PubSubModule } from '@mannercode/common'
import { BullModule } from '@nestjs/bullmq'
import { Module } from '@nestjs/common'
import { RedisConfigModule } from 'config'
import { MoviesModule, ShowtimesModule, TheatersModule, TicketsModule } from 'cores'
import {
    ShowtimeBulkCreatorService,
    ShowtimeBulkValidatorService,
    ShowtimeCreationWorkerService
} from './services'
import { ShowtimeCreationEvents } from './showtime-creation.events'
import { ShowtimeCreationService } from './showtime-creation.service'

@Module({
    exports: [ShowtimeCreationService, ShowtimeCreationEvents],
    imports: [
        BullModule.registerQueue({ configKey: 'queue', name: 'showtime-creation' }),
        PubSubModule.register({ redisName: RedisConfigModule.connectionName }),
        MoviesModule,
        TheatersModule,
        ShowtimesModule,
        TicketsModule
    ],
    providers: [
        ShowtimeCreationEvents,
        ShowtimeCreationService,
        ShowtimeCreationWorkerService,
        ShowtimeBulkValidatorService,
        ShowtimeBulkCreatorService
    ]
})
export class ShowtimeCreationModule {}
