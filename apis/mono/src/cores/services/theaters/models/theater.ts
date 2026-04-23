import { createCrudSchema, CrudSchema } from '@mannercode/common'
import { Prop, Schema } from '@nestjs/mongoose'
import { MongooseConfigModule } from 'config'
import { Seatmap } from './seatmap'
import { TheaterLocation } from './theater-location'

@Schema(MongooseConfigModule.schemaOptions)
export class Theater extends CrudSchema {
    @Prop({
        _id: false,
        required: true,
        type: {
            latitude: { required: true, type: Number },
            longitude: { required: true, type: Number }
        }
    })
    location: TheaterLocation

    @Prop({ required: true })
    name: string

    @Prop({ _id: false, required: true, type: Object })
    seatmap: Seatmap
}
export const TheaterSchema = createCrudSchema(Theater)

// cycle-23: 과거 `{ name: 'text' }` text index 는 실제 `$text` 쿼리에
// 쓰이지 않아 drop. 현재 검색은 cycle-10 prefix regex + cycle-12 compound
// index 로 처리.

// 일반 ascending 인덱스 — prefix-anchored regex (`^value`) 의 prefix range
// scan 활용 (cycle-10).
TheaterSchema.index({ name: 1 })

// Compound index — soft-delete 필터 (`deletedAt: null`) 가 자동으로 추가되는
// 환경에서, planner 가 단일 `name: 1` 인덱스를 외면하고 `deletedAt: 1` 를 선택해
// COLLSCAN-equivalent 가 되는 문제 해결 (cycle-10 → 12).
//
// 순서가 중요: `{deletedAt: 1, name: 1}` 로 deletedAt 이 prefix 가 되면
// planner 가 기존 단일 `deletedAt_1` 대신 이 compound 를 선호하게 되고,
// 이어지는 name prefix range scan 이 IXSCAN 안에서 처리됨.
// `{name: 1, deletedAt: 1}` 순서는 planner 가 안 고름 (테스트 확인).
TheaterSchema.index({ deletedAt: 1, name: 1 })
