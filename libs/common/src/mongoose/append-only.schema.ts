import type { Type } from '@nestjs/common'
import type { Schema } from 'mongoose'
import { SchemaFactory } from '@nestjs/mongoose'

/**
 * Append-only category 의 schema base.
 *
 * CRUD 와 직교한 별개 category. update/delete 가 절대 일어나지 않는 모델용
 * (audit log, event log, immutable history 등).
 *
 * `CrudSchema` 와 달리 `updatedAt`/`deletedAt` 필드가 없다 — append-only 에서는
 * 의미가 없기 때문. createdAt 만 노출한다.
 *
 * `createAppendOnlySchema` factory 가 schema 레벨에서 모든 mutation operation 을
 * throw 로 막아 ORM 우회 (model.updateOne 등 직접 호출) 까지 차단한다.
 */
export abstract class AppendOnlySchema {
    createdAt: Date
    id: string
}

export function createAppendOnlySchema<T>(cls: Type<T>): Schema<T> {
    const schema = SchemaFactory.createForClass(cls)

    // Query-level mutation 차단 (model.updateOne, model.deleteOne 등 직접 호출)
    const throwMutation = function () {
        throw new Error(`${cls.name} is append-only; mutation is not allowed`)
    }
    schema.pre('updateOne', throwMutation)
    schema.pre('updateMany', throwMutation)
    schema.pre('findOneAndUpdate', throwMutation)
    schema.pre('findOneAndReplace', throwMutation)
    schema.pre('replaceOne', throwMutation)
    schema.pre('deleteOne', throwMutation)
    schema.pre('deleteMany', throwMutation)

    // Document-level deleteOne 차단 (doc.deleteOne())
    schema.pre('deleteOne', { document: true, query: false }, function () {
        throw new Error(`${cls.name} is append-only; delete is not allowed`)
    })

    // save() 는 신규 insert 만 허용 — 기존 문서 update 차단
    schema.pre('save', function () {
        if (!this.isNew) {
            throw new Error(`${cls.name} is append-only; cannot modify existing document`)
        }
    })

    return schema
}
