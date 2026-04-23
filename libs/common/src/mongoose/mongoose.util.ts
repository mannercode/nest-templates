import { BadRequestException } from '@nestjs/common'
import { Types, QueryFilter } from 'mongoose'
import { escapeRegExp, uniq } from '../utils'
import { Verify } from '../validator'
import { MongooseErrors } from './errors'

export const newObjectIdString = () => new Types.ObjectId().toString()
export const objectId = (id: string) => new Types.ObjectId(id)
export const objectIds = (ids: string[]) => ids.map((id) => objectId(id))

/**
 * MongoDB duplicate key error (E11000) 판별.
 * Unique index 위반시 race-safe 한 Conflict 처리를 위해 사용.
 */
export function isDuplicateKeyError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000
}

export type QueryBuilderOptions = { allowEmpty?: boolean }

type Transform<T> = (value: T) => any

export class QueryBuilder<T> {
    private query: any = {}

    addEquals(field: string, value?: any): this {
        if (value !== undefined && value !== null) {
            this.query[field] = value
        }
        return this
    }

    addId(field: string, id?: string): this {
        if (id) {
            this.query[field] = objectId(id)
        }
        return this
    }

    addIn(field: string, ids?: string[]): this {
        if (ids && ids.length > 0) {
            const uniqueIds = uniq(ids)

            Verify.equalLength(
                uniqueIds,
                ids,
                `Duplicate ${String(field)} detected and removed: ${ids}`
            )
            this.query[field] = { $in: uniqueIds }
        }
        return this
    }

    addRange(field: string, range?: { end?: Date; start?: Date }): this {
        if (range) {
            const { end, start } = range

            if (start && end) {
                this.query[field] = { $gte: start, $lte: end }
            } else if (start) {
                this.query[field] = { $gte: start }
            } else if (end) {
                this.query[field] = { $lte: end }
            }
        }

        return this
    }

    addRegex(
        field: string,
        value?: string,
        options?: { caseSensitive?: boolean; prefix?: boolean }
    ): this {
        if (value) {
            // Substring match (기본) 은 어떤 인덱스도 활용하지 못해 COLLSCAN 이
            // 됨 (cycle-09 측정: 216K docs 에서 23 RPS). 더 빠르게 가려면:
            //  - `prefix: true` 로 `^value` 앵커링 → prefix range scan 후보
            //  - `caseSensitive: true` 로 `i` flag 제거 → 일반 ascending 인덱스
            //    (`{ field: 1 }`) 활용 가능. case-insensitive 인덱스가 따로
            //    있다면 caseSensitive 없이도 되지만 mongoose 기본 인덱스는 그냥
            //    binary 비교라 `i` flag 와 호환 안 됨.
            //  prefix + caseSensitive 둘 다 켜야 진짜 IXSCAN 으로 떨어진다 (cycle-10).
            const pattern = options?.prefix ? '^' + escapeRegExp(value) : escapeRegExp(value)
            this.query[field] = options?.caseSensitive
                ? new RegExp(pattern)
                : new RegExp(pattern, 'i')
        }
        return this
    }

    build({ allowEmpty }: QueryBuilderOptions): QueryFilter<T> {
        if (!allowEmpty && Object.keys(this.query).length === 0) {
            throw new BadRequestException(MongooseErrors.FiltersRequired())
        }

        return this.query
    }
}

export function assignIfDefined<
    Target extends Record<string, any>,
    Source extends Record<string, any>,
    K extends keyof Source & keyof Target
>(target: Target, source: Source, key: K, transform?: Transform<NonNullable<Source[K]>>): void {
    const value = source[key]
    if (value === undefined) return

    target[key] = transform ? transform(value) : value
}

export function mapDocToDto<Doc extends object, Dto extends object, K extends keyof Dto>(
    doc: Doc,
    dtoClass: new () => Dto,
    keys: K[]
): Dto {
    const dto = new dtoClass()
    const record = doc as Record<string, unknown>

    for (const key of keys) {
        const value = record[key as string]
        dto[key] = value as Dto[K]
    }

    return dto
}
