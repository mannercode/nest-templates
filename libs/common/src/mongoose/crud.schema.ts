import type { Type } from '@nestjs/common'
import type { ClientSession, Query, Schema } from 'mongoose'
import { SchemaFactory } from '@nestjs/mongoose'
import { defaultTo } from '../utils'

/**
 * The difference between toObject and toJSON is that toJSON has flattenMaps set to true by default.
 * toObject와 toJSON의 차이는 toJSON는 flattenMaps의 기본값이 true라는 것 뿐이다.
 *
 * @Schema()
 * export class Sample {
 *     @Prop({ type: Map, of: String })
 *     attributes: Map<string, string>
 * }
 *
 * console.log(sample.toObject())
 * attributes: Map(2) { 'key1' => 'value1', 'key2' => 'value2' },
 *
 * console.log(sample.toJSON())
 * attributes: { key1: 'value1', key2: 'value2' },
 */

/**
 * CRUD category 의 schema base.
 *
 * 일반적인 도메인 엔티티(생성/조회/수정/삭제 모두 가능)용. soft-delete 가 default 이고
 * `@HardDelete()` 데코레이터로 모델별 hard-delete opt-out 가능.
 *
 * Append-only category (audit log 등) 는 본 base 가 아니라 `AppendOnlySchema` /
 * `createAppendOnlySchema` 를 사용한다.
 */
export abstract class CrudSchema {
    createdAt: Date
    deletedAt: Date | null
    id: string
    updatedAt: Date
}

const HARD_DELETE_KEY = 'HardDelete'
export function addDeletedAtFilterToPipeline(pipeline: Record<string, any>[]) {
    const matchStage = { $match: { deletedAt: null } }
    const firstStage = pipeline[0] ?? {}

    if ('$geoNear' in firstStage || '$search' in firstStage || '$vectorSearch' in firstStage) {
        pipeline.splice(1, 0, matchStage)
        return
    }

    pipeline.unshift(matchStage)
}

export function createCrudSchema<T>(cls: Type<T>): Schema<T> {
    const schema = SchemaFactory.createForClass(cls)

    const isHardDelete = defaultTo(Reflect.getMetadata(HARD_DELETE_KEY, cls), false)
    if (isHardDelete === false) {
        schema.add({ deletedAt: { default: null, type: Date } } as any)
        // An index is set on deletedAt because it is frequently queried in soft delete scenarios.
        // soft delete 상황에서 deletedAt이 자주 조회되므로 인덱스를 설정함
        schema.index({ deletedAt: 1 })

        schema.pre('find', excludeDeletedMiddleware)
        schema.pre('findOne', excludeDeletedMiddleware)
        schema.pre('findOneAndUpdate', excludeDeletedMiddleware)
        schema.pre('findOneAndReplace', excludeDeletedMiddleware)
        schema.pre('updateOne', excludeDeletedMiddleware)
        schema.pre('updateMany', excludeDeletedMiddleware)
        schema.pre('countDocuments', excludeDeletedMiddleware)
        schema.pre('distinct', excludeDeletedMiddleware)
        schema.pre('aggregate', function () {
            addDeletedAtFilterToPipeline(this.pipeline())
        })
        schema.statics.deleteOne = async function (
            conditions,
            options?: { session?: ClientSession }
        ) {
            const updateResult = await this.updateOne(
                conditions,
                { deletedAt: new Date() },
                options
            ).exec()
            return { deletedCount: updateResult.modifiedCount }
        }
        schema.statics.deleteMany = async function (
            conditions,
            options?: { session?: ClientSession }
        ) {
            const updateResult = await this.updateMany(
                conditions,
                { deletedAt: new Date() },
                options
            ).exec()
            return { deletedCount: updateResult.modifiedCount }
        }
        schema.statics.findOneAndDelete = async function (
            conditions,
            options?: { session?: ClientSession }
        ) {
            return this.findOneAndUpdate(
                conditions,
                { deletedAt: new Date() },
                { ...options, returnDocument: 'before' }
            ).exec()
        }
        schema.methods.deleteOne = async function (options?: { session?: ClientSession }) {
            this.deletedAt = new Date()
            return this.save(options)
        }
        // bulkWrite: softDelete middleware 를 우회하므로 각 operation 의 filter 에
        // deletedAt null 을 주입한다
        schema.pre('bulkWrite', function (ops) {
            for (const op of ops) {
                if ('updateOne' in op) {
                    op.updateOne.filter = { ...op.updateOne.filter, deletedAt: null }
                } else if ('updateMany' in op) {
                    op.updateMany.filter = { ...op.updateMany.filter, deletedAt: null }
                } else if ('replaceOne' in op) {
                    op.replaceOne.filter = { ...op.replaceOne.filter, deletedAt: null }
                } else if ('deleteOne' in op) {
                    const filter = op.deleteOne.filter
                    delete (op as any).deleteOne
                    ;(op as any).updateOne = {
                        filter: { ...filter, deletedAt: null },
                        update: { deletedAt: new Date() }
                    }
                } else if ('deleteMany' in op) {
                    const filter = op.deleteMany.filter
                    delete (op as any).deleteMany
                    ;(op as any).updateMany = {
                        filter: { ...filter, deletedAt: null },
                        update: { deletedAt: new Date() }
                    }
                }
            }
        })
    }

    return schema
}

export function HardDelete() {
    return (target: object) => {
        Reflect.defineMetadata(HARD_DELETE_KEY, true, target)
    }
}

function excludeDeletedMiddleware(this: Query<any, any>) {
    if (!this.getOptions().withDeleted) {
        this.where({ deletedAt: null })
    }
}
