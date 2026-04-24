import { expectEqualUnsorted, nullObjectId } from '@mannercode/testing'
import { Types } from 'mongoose'
import { OrderDirection } from '../../pagination'
import { pickIds } from '../../utils'
import { leanToPublic } from '../crud.repository'
import {
    CrudRepositoryFixture,
    SampleDto,
    createSample,
    createSamples,
    maxSizeValue,
    sortByName,
    sortByNameDescending,
    toDto,
    toDtos
} from './crud.repository.fixture'

describe('CrudRepository', () => {
    let fix: CrudRepositoryFixture

    beforeEach(async () => {
        const { createCrudRepositoryFixture } = await import('./crud.repository.fixture')
        fix = await createCrudRepositoryFixture()
    })
    afterEach(() => fix.teardown())

    describe('save', () => {
        // 문서를 생성한다
        it('creates the document', async () => {
            const newDoc = fix.repository.newDocument()
            newDoc.name = 'document name'
            await newDoc.save()

            const foundDoc = await fix.repository.findById(newDoc.id)
            expect(toDto(foundDoc)).toEqual(toDto(newDoc))
        })

        // 필수 필드가 없으면 예외를 던진다
        it('throws for missing required fields', async () => {
            const doc = fix.repository.newDocument()
            const promise = doc.save()
            await expect(promise).rejects.toThrow()
        })
    })

    describe('saveMany', () => {
        // 모든 문서를 생성한다
        it('creates all documents', async () => {
            const docs = [
                { name: 'document-1' },
                { name: 'document-2' },
                { name: 'document-2' }
            ].map((data) => {
                const doc = fix.repository.newDocument()
                doc.name = data.name
                return doc
            })

            await expect(fix.repository.saveMany(docs)).resolves.toBeUndefined()
        })

        // 필수 필드가 없으면 예외를 던진다
        it('throws for missing required fields', async () => {
            const docs = [fix.repository.newDocument(), fix.repository.newDocument()]

            const promise = fix.repository.saveMany(docs)

            await expect(promise).rejects.toThrow()
        })
    })

    describe('findWithPagination', () => {
        let samples: SampleDto[]

        beforeEach(async () => {
            const docs = await createSamples(fix.repository)
            samples = toDtos(docs)
        })

        // 올바른 페이지네이션으로 항목을 반환한다
        it('returns items with correct pagination', async () => {
            const page = 3
            const size = 5
            const { items, ...pagination } = await fix.repository.findWithPagination({
                pagination: { size, orderby: { direction: OrderDirection.Asc, name: 'name' }, page }
            })

            sortByName(samples)
            const skip = (page - 1) * size
            expect(samples.slice(skip, skip + size)).toEqual(toDtos(items))
            expect(pagination).toEqual({ size, page, total: samples.length })
        })

        // 오름차순으로 정렬한다
        it('sorts in ascending order', async () => {
            const { items } = await fix.repository.findWithPagination({
                pagination: {
                    orderby: { direction: OrderDirection.Asc, name: 'name' },
                    size: samples.length
                }
            })

            sortByName(samples)
            expect(toDtos(items)).toEqual(samples)
        })

        // 내림차순으로 정렬한다
        it('sorts in descending order', async () => {
            const { items } = await fix.repository.findWithPagination({
                pagination: {
                    orderby: { direction: OrderDirection.Desc, name: 'name' },
                    size: samples.length
                }
            })

            sortByNameDescending(samples)
            expect(toDtos(items)).toEqual(samples)
        })

        // size 값이 0 이하이면 예외를 던진다
        it('throws for a non-positive size value', async () => {
            const promise = fix.repository.findWithPagination({ pagination: { size: -1 } })

            await expect(promise).rejects.toThrow(fix.BadRequestException)
        })

        // maxLimit을 초과한 size에 대해 BadRequestException을 던진다
        it('throws BadRequestException for size above the max', async () => {
            const size = maxSizeValue + 1

            const promise = fix.repository.findWithPagination({ pagination: { size } })

            await expect(promise).rejects.toThrow(fix.BadRequestException)
        })

        // size가 제공되지 않을 때
        describe('when size is not provided', () => {
            // 기본 size 값을 사용한다
            it('uses the default size value', async () => {
                const { size } = await fix.repository.findWithPagination({
                    pagination: { orderby: { direction: OrderDirection.Desc, name: 'name' } }
                })

                expect(size).toEqual(maxSizeValue)
            })
        })

        // 설정된 조건을 적용한다
        it('applies configured conditions', async () => {
            const { items } = await fix.repository.findWithPagination({
                configureQuery: async (queryHelper) => {
                    queryHelper.setQuery({ name: /Sample-00/i })
                },
                pagination: { size: 10 }
            })

            const names = sortByName(toDtos(items)).map(({ name }) => name)

            expect(names).toEqual([
                'Sample-000',
                'Sample-001',
                'Sample-002',
                'Sample-003',
                'Sample-004',
                'Sample-005',
                'Sample-006',
                'Sample-007',
                'Sample-008',
                'Sample-009'
            ])
        })
    })

    describe('allExist', () => {
        let samples: SampleDto[]

        beforeEach(async () => {
            const docs = await createSamples(fix.repository)
            samples = toDtos(docs)
        })

        // 모든 id가 존재할 때
        describe('when all ids exist', () => {
            // true를 반환한다
            it('returns true', async () => {
                const exists = await fix.repository.allExist(pickIds(samples))
                expect(exists).toBe(true)
            })
        })

        // id에 중복이 포함될 때
        describe('when ids contain duplicates', () => {
            // true를 반환한다
            it('returns true', async () => {
                const [first] = samples
                const exists = await fix.repository.allExist([first.id, first.id])

                expect(exists).toBe(true)
            })
        })

        // id 중 하나라도 없을 때
        describe('when any id is missing', () => {
            // false를 반환한다
            it('returns false', async () => {
                const exists = await fix.repository.allExist([nullObjectId])
                expect(exists).toBe(false)
            })
        })

        // id 배열이 비어 있을 때
        describe('when ids are empty', () => {
            // true를 반환한다
            it('returns true', async () => {
                const exists = await fix.repository.allExist([])
                expect(exists).toBe(true)
            })
        })
    })

    describe('findById', () => {
        let sample: SampleDto

        beforeEach(async () => {
            const doc = await createSample(fix.repository)
            sample = toDto(doc)
        })

        // 존재하는 id의 문서를 반환한다
        it('returns the document for an existing id', async () => {
            const doc = await fix.repository.findById(sample.id)

            expect(toDto(doc)).toEqual(sample)
        })

        // 없는 id에 대해 null을 반환한다
        it('returns null for a missing id', async () => {
            const doc = await fix.repository.findById(nullObjectId)

            expect(doc).toBeNull()
        })
    })

    describe('findByIds', () => {
        let samples: SampleDto[]

        beforeEach(async () => {
            const docs = await createSamples(fix.repository)
            samples = toDtos(docs)
        })

        // 존재하는 id의 문서를 반환한다
        it('returns the documents for existing ids', async () => {
            const ids = pickIds(samples)
            const docs = await fix.repository.findByIds(ids)

            expectEqualUnsorted(toDtos(docs), samples)
        })

        // 없는 id는 무시한다
        it('ignores missing ids', async () => {
            const docs = await fix.repository.findByIds([nullObjectId])
            expect(docs).toHaveLength(0)
        })
    })

    describe('getById', () => {
        let sample: SampleDto

        beforeEach(async () => {
            const doc = await createSample(fix.repository)
            sample = toDto(doc)
        })

        // 존재하는 id의 문서를 반환한다
        it('returns the document for an existing id', async () => {
            const doc = await fix.repository.getById(sample.id)
            expect(toDto(doc)).toEqual(sample)
        })

        // 없는 id에 대해 NotFoundException을 던진다
        it('throws NotFoundException for a missing id', async () => {
            const promise = fix.repository.getById(nullObjectId)

            await expect(promise).rejects.toThrow(fix.NotFoundException)
        })
    })

    describe('getByIds', () => {
        let samples: SampleDto[]

        beforeEach(async () => {
            const docs = await createSamples(fix.repository)
            samples = toDtos(docs)
        })

        // 모든 id가 존재할 때
        describe('when all ids exist', () => {
            // 문서를 반환한다
            it('returns the documents', async () => {
                const ids = pickIds(samples)
                const docs = await fix.repository.getByIds(ids)

                expectEqualUnsorted(toDtos(docs), samples)
            })
        })

        // id 중 하나라도 없을 때
        describe('when any id is missing', () => {
            // NotFoundException을 던진다
            it('throws NotFoundException', async () => {
                const promise = fix.repository.getByIds([nullObjectId])

                await expect(promise).rejects.toThrow(fix.NotFoundException)
            })
        })
    })

    describe('deleteById', () => {
        let sample: SampleDto

        beforeEach(async () => {
            const doc = await createSample(fix.repository)
            sample = toDto(doc)
        })

        // 존재하는 id의 문서를 삭제한다
        it('deletes the document for an existing id', async () => {
            await fix.repository.deleteById(sample.id)
            const doc = await fix.repository.findById(sample.id)

            expect(doc).toBeNull()
        })

        // 없는 id에 대해 NotFoundException을 던진다
        it('throws NotFoundException for a missing id', async () => {
            const promise = fix.repository.deleteById(nullObjectId)

            await expect(promise).rejects.toThrow(fix.NotFoundException)
        })
    })

    describe('deleteByIds', () => {
        let samples: SampleDto[]

        beforeEach(async () => {
            const docs = await createSamples(fix.repository)
            samples = toDtos(docs)
        })

        // 모든 id가 존재할 때
        describe('when all ids exist', () => {
            // 문서를 삭제한다
            it('deletes the documents', async () => {
                const ids = pickIds(samples.slice(5, 10))
                const result = await fix.repository.deleteByIds(ids)
                expect(result).toEqual({ deletedCount: ids.length })

                const docs = await fix.repository.findByIds(ids)
                expect(docs).toHaveLength(0)
            })
        })

        // id 중 하나라도 없을 때
        describe('when any id is missing', () => {
            // 없는 id는 무시한다
            it('ignores missing ids', async () => {
                const promise = fix.repository.deleteByIds([nullObjectId])
                await expect(promise).resolves.toEqual({ deletedCount: 0 })
            })
        })
    })
})

describe('leanToPublic', () => {
    // _id 가 있을 때 id 필드를 추가한다
    it('maps _id to id when _id is present', () => {
        const objectId = new Types.ObjectId()
        const result = leanToPublic<{ _id: Types.ObjectId; id?: string }>({ _id: objectId })
        expect(result.id).toBe(String(objectId))
    })

    // _id 가 nullish 이면 id 를 추가하지 않는다
    it('leaves doc unchanged when _id is nullish', () => {
        const result = leanToPublic<{ _id?: unknown; id?: string }>({})
        expect(result.id).toBeUndefined()
    })
})
