import { CacheModule } from '@mannercode/common'
import { Module } from '@nestjs/common'
import { getProjectId, RedisConfigModule } from 'config'
import { PurchaseRecordsModule, ShowtimesModule, TicketHoldingModule, TicketsModule } from 'cores'
import { PaymentsModule } from 'infrastructures'
import { PurchaseEvents } from './purchase.events'
import { PurchaseService } from './purchase.service'
import { TicketPurchaseService } from './services'

@Module({
    exports: [PurchaseService],
    imports: [
        TicketsModule,
        TicketHoldingModule,
        PurchaseRecordsModule,
        ShowtimesModule,
        PaymentsModule,
        CacheModule.register({
            name: 'purchase',
            prefix: `cache:${getProjectId()}`,
            redisName: RedisConfigModule.connectionName
        })
    ],
    providers: [PurchaseService, TicketPurchaseService, PurchaseEvents]
})
export class PurchaseModule {}
