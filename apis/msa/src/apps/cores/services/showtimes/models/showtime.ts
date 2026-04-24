import { createCrudSchema, HardDelete, CrudSchema } from '@mannercode/common'
import { Prop, Schema } from '@nestjs/mongoose'
import { MongooseConfigModule } from 'config'

@HardDelete()
@Schema(MongooseConfigModule.schemaOptions)
export class Showtime extends CrudSchema {
    @Prop({ required: true })
    endTime: Date

    @Prop({ required: true })
    movieId: string

    @Prop({ required: true })
    sagaId: string

    @Prop({ required: true })
    startTime: Date

    @Prop({ required: true })
    theaterId: string
}
export const ShowtimeSchema = createCrudSchema(Showtime)

// cycle-19: booking 경로의 주 쿼리 패턴 `{theaterId, startTime range}` 용
// compound index. HardDelete 스키마라 deletedAt 필터는 없음.
ShowtimeSchema.index({ theaterId: 1, startTime: 1 })
// saga op 경로 (`deleteBySagaIds`) 용 단일 인덱스.
ShowtimeSchema.index({ sagaId: 1 })
