import { createCrudSchema, CrudSchema } from '@mannercode/common'
import { Prop, Schema } from '@nestjs/mongoose'
import { MongooseConfigModule } from 'config'

@Schema(MongooseConfigModule.schemaOptions)
export class Customer extends CrudSchema {
    @Prop({ required: true })
    birthDate: Date

    @Prop({ required: true, unique: true })
    email: string

    @Prop({ required: true })
    name: string

    @Prop({ required: true, select: false })
    password: string
}
export const CustomerSchema = createCrudSchema(Customer)

// cycle-23: `{ name: 'text' }` text index drop (실제 $text 쿼리 미사용).
// customers 검색은 cycle-15b 의 prefix regex + compound 로 처리.

// Compound indexes — cycle-15b. theater/movie 와 동일 패턴.
// customers 는 `GET /customers` 가 JWT 보호라 현재 perf 하네스로 실측 불가.
// 같은 CrudRepository.findWithPagination + mongo planner 경로이므로
// 효과는 이론상 동일 (cycle-12 에서 150× / cycle-15 에서 123× 입증).
CustomerSchema.index({ deletedAt: 1, name: 1 })
CustomerSchema.index({ deletedAt: 1, email: 1 })
