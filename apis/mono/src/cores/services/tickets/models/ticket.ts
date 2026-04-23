import { createCrudSchema, CrudSchema } from '@mannercode/common'
import { Prop, Schema } from '@nestjs/mongoose'
import { MongooseConfigModule } from 'config'
import { Seat } from '../../../shared'

export enum TicketStatus {
    Available = 'available',
    Sold = 'sold'
}

@Schema(MongooseConfigModule.schemaOptions)
export class Ticket extends CrudSchema {
    @Prop({ required: true })
    movieId: string

    @Prop({ required: true })
    sagaId: string

    @Prop({ required: true, type: Object })
    seat: Seat

    @Prop({ required: true })
    showtimeId: string

    @Prop({ enum: TicketStatus, required: true, type: String })
    status: TicketStatus

    @Prop({ required: true })
    theaterId: string
}
export const TicketSchema = createCrudSchema(Ticket)

// cycle-22: 빈번한 쿼리 경로 가속.
// - `{deletedAt:1, showtimeId:1}` — `aggregateSales`, ticket-holding race 경로
//   (특정 showtime 의 티켓 조회/집계). soft-delete 필터 자동 포함 커버.
// - `{sagaId:1}` — `deleteBySagaIds` 및 saga 조회 경로.
TicketSchema.index({ deletedAt: 1, showtimeId: 1 })
TicketSchema.index({ sagaId: 1 })
