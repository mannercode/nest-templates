import { BadRequestException, Logger } from '@nestjs/common'
import { Prop, Schema } from '@nestjs/mongoose'
import { model, Types } from 'mongoose'
import { createCrudSchema, CrudSchema } from '../crud.schema'
import {
    assignIfDefined,
    mapDocToDto,
    newObjectIdString,
    objectId,
    objectIds,
    QueryBuilder
} from '../mongoose.util'

it('generates a new ObjectId string', async () => {
    const objectIdValue = newObjectIdString()
    expect(Types.ObjectId.isValid(objectIdValue)).toBe(true)
})

describe('objectId', () => {
    // 유효한 문자열을 ObjectId로 변환한다
    it('converts a valid string to an ObjectId', () => {
        const idString = '507f1f77bcf86cd799439011'
        const result = objectId(idString)

        expect(result).toBeInstanceOf(Types.ObjectId)
        expect(result.toString()).toBe(idString)
    })

    // 유효하지 않은 문자열이면 예외를 던진다
    it('throws for an invalid string', () => {
        const invalidId = 'invalid-id'

        expect(() => objectId(invalidId)).toThrow(
            'input must be a 24 character hex string, 12 byte Uint8Array, or an integer'
        )
    })
})

describe('objectIds', () => {
    // 모든 id가 유효할 때
    describe('when all ids are valid', () => {
        // ObjectId로 변환한다
        it('converts them to ObjectIds', () => {
            const idStrings = ['507f1f77bcf86cd799439011', '507f1f77bcf86cd799439012']
            const result = objectIds(idStrings)

            expect(result.map((id) => id.toString())).toEqual(idStrings)
            expect(result).toEqual([expect.any(Types.ObjectId), expect.any(Types.ObjectId)])
        })
    })

    // id가 비어 있을 때
    describe('when ids are empty', () => {
        // 빈 배열을 반환한다
        it('returns an empty array', () => {
            const result = objectIds([])

            expect(result).toEqual([])
        })
    })

    // id 중 하나라도 유효하지 않을 때
    describe('when any id is invalid', () => {
        // 예외를 던진다
        it('throws', () => {
            const idStrings = ['507f1f77bcf86cd799439011', 'invalid-id']

            expect(() => objectIds(idStrings)).toThrow(
                'input must be a 24 character hex string, 12 byte Uint8Array, or an integer'
            )
        })
    })
})

describe('QueryBuilder', () => {
    type TestModel = { _id: Types.ObjectId; createdAt: Date; entityId: string; name: string }

    let builder: QueryBuilder<TestModel>

    beforeEach(() => {
        builder = new QueryBuilder<TestModel>()
    })

    describe('addEqual', () => {
        // 값이 제공될 때
        describe('when the value is provided', () => {
            // 조건을 추가한다
            it('adds the condition', () => {
                builder.addEquals('name', 'test')
                expect(builder.build({})).toEqual({ name: 'test' })
            })
        })

        // 값이 제공되지 않을 때
        describe('when the value is not provided', () => {
            // 조건을 추가하지 않는다
            it('does not add the condition', () => {
                builder.addEquals('name', undefined)
                builder.addEquals('name', null)
                expect(builder.build({ allowEmpty: true })).toEqual({})
            })
        })
    })

    describe('addId', () => {
        // id가 제공될 때
        describe('when the id is provided', () => {
            // ObjectId 조건을 추가한다
            it('adds the ObjectId condition', () => {
                const id = new Types.ObjectId().toString()
                builder.addId('_id', id)
                expect(builder.build({})).toEqual({ _id: objectId(id) })
            })
        })

        // id가 제공되지 않을 때
        describe('when the id is not provided', () => {
            // 조건을 추가하지 않는다
            it('does not add the condition', () => {
                builder.addId('_id', undefined)
                expect(builder.build({ allowEmpty: true })).toEqual({})
            })
        })
    })

    describe('addIn', () => {
        // ids가 제공될 때
        describe('when ids are provided', () => {
            const ids = ['123', '456']

            // $in 조건을 추가한다
            it('adds an $in condition', () => {
                builder.addIn('entityId', ids)
                expect(builder.build({})).toEqual({ entityId: { $in: ids } })
            })
        })

        // ids에 중복이 있을 때
        describe('when ids contain duplicates', () => {
            const ids = ['123', '123']

            beforeEach(() => {
                jest.spyOn(Logger, 'warn').mockImplementation(() => {})
            })

            // 중복을 제거한다
            it('removes duplicates', () => {
                builder.addIn('entityId', ids)
                expect(builder.build({})).toEqual({ entityId: { $in: ['123'] } })
            })
        })

        // ids가 비어 있거나 제공되지 않을 때
        describe('when ids are empty or not provided', () => {
            // 조건을 추가하지 않는다
            it('does not add the condition', () => {
                builder.addIn('entityId', [])
                builder.addIn('entityId', undefined)
                expect(builder.build({ allowEmpty: true })).toEqual({})
            })
        })
    })

    describe('addRegex', () => {
        // 값이 제공될 때
        describe('when the value is provided', () => {
            // 정규식 조건을 추가한다
            it('adds a regex condition', () => {
                builder.addRegex('name', 'test')
                expect(builder.build({})).toEqual({ name: new RegExp('test', 'i') })
            })
        })

        // 값이 제공되지 않을 때
        describe('when the value is not provided', () => {
            // 조건을 추가하지 않는다
            it('does not add the condition', () => {
                builder.addRegex('name', undefined)
                expect(builder.build({ allowEmpty: true })).toEqual({})
            })
        })
    })

    describe('addRange', () => {
        // start와 end가 제공될 때
        describe('when start and end are provided', () => {
            // $gte와 $lte 조건을 추가한다
            it('adds $gte and $lte conditions', () => {
                const range = { end: new Date('2023-12-31'), start: new Date('2023-01-01') }
                builder.addRange('createdAt', range)
                expect(builder.build({})).toEqual({
                    createdAt: { $gte: range.start, $lte: range.end }
                })
            })
        })

        // start만 제공될 때
        describe('when only start is provided', () => {
            // $gte만 추가한다
            it('adds only $gte', () => {
                const range = { start: new Date('2023-01-01') }
                builder.addRange('createdAt', range)
                expect(builder.build({})).toEqual({ createdAt: { $gte: range.start } })
            })
        })

        // end만 제공될 때
        describe('when only end is provided', () => {
            // $lte만 추가한다
            it('adds only $lte', () => {
                const range = { end: new Date('2023-12-31') }
                builder.addRange('createdAt', range)
                expect(builder.build({})).toEqual({ createdAt: { $lte: range.end } })
            })
        })

        // range가 비어 있거나 제공되지 않을 때
        describe('when the range is empty or not provided', () => {
            // 조건을 추가하지 않는다
            it('does not add the condition', () => {
                builder.addRange('createdAt', undefined)
                builder.addRange('createdAt', {})
                expect(builder.build({ allowEmpty: true })).toEqual({})
            })
        })
    })

    describe('build', () => {
        // 조건이 존재할 때
        describe('when conditions exist', () => {
            // 쿼리 객체를 반환한다
            it('returns the query object', () => {
                builder.addEquals('name', 'test')
                expect(builder.build({})).toEqual({ name: 'test' })
            })
        })

        // 조건이 없을 때
        describe('when no conditions exist', () => {
            // BadRequestException을 던진다
            it('throws BadRequestException', () => {
                expect(() => builder.build({})).toThrow(BadRequestException)
            })
        })

        // allowEmpty가 true일 때
        describe('when allowEmpty is true', () => {
            // 빈 쿼리를 반환한다
            it('returns an empty query', () => {
                expect(builder.build({ allowEmpty: true })).toEqual({})
            })
        })
    })
})

describe('mapDocToDto', () => {
    @Schema({ toJSON: { virtuals: true } })
    class Sample extends CrudSchema {
        @Prop()
        name: string

        @Prop()
        optional?: boolean
    }

    class SampleDto {
        id: string
        name: string
        optional?: boolean
    }

    const sampleSchema = createCrudSchema(Sample)
    const SampleModel = model<Sample>('SampleForTest', sampleSchema)

    // lean 객체를 DTO로 매핑한다
    it('maps a lean object to a DTO', () => {
        const doc = new SampleModel({ name: 'name', optional: undefined }).toJSON()

        const dto = mapDocToDto(doc, SampleDto, ['id', 'name', 'optional'])

        expect(dto).toEqual({ id: expect.any(String), name: 'name', optional: undefined })
    })
})

describe('assignIfDefined', () => {
    // source[key]가 정의되어 있을 때
    describe('when source[key] is defined', () => {
        // target[key]에 할당한다
        it('assigns target[key]', () => {
            const target = { name: 'old' }
            const source = { name: 'new' as string | undefined }

            assignIfDefined(target, source, 'name')

            expect(target.name).toBe('new')
        })
    })

    // source[key]가 제공되지 않을 때
    describe('when source[key] is not provided', () => {
        // target을 변경하지 않는다
        it('does not change target', () => {
            const target = { name: 'old' }
            const source = { name: undefined as string | undefined }

            assignIfDefined(target, source, 'name')

            expect(target.name).toBe('old')
        })
    })

    // transform이 제공될 때
    describe('when transform is provided', () => {
        // 변환된 값을 할당한다
        it('assigns the transformed value', () => {
            const target = { id: 'old' }
            const source = { id: '123' as string | undefined }

            assignIfDefined(target, source, 'id', (v) => `obj:${v}`)

            expect(target.id).toBe('obj:123')
        })
    })

    // source[key]가 null일 때
    describe('when source[key] is null', () => {
        // null을 정의된 값으로 취급한다
        it('treats null as defined', () => {
            const target = { email: 'old' as null | string }
            const source = { email: null as null | string | undefined }

            assignIfDefined(target, source, 'email')

            expect(target.email).toBeNull()
        })
    })
})
