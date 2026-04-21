import type { HydratedDocument } from 'mongoose'
import { HardDeleteSample, SoftDeleteSample, CrudDeleteFixture } from './crud-delete.fixture'

describe('Crud Delete', () => {
    describe('Soft Delete', () => {
        let fix: CrudDeleteFixture<SoftDeleteSample>
        let createdDoc: HydratedDocument<SoftDeleteSample>

        beforeEach(async () => {
            const { createCrudDeleteFixture } = await import('./crud-delete.fixture')
            fix = await createCrudDeleteFixture(SoftDeleteSample)

            createdDoc = new fix.model()
            createdDoc.name = 'name'
            await createdDoc.save()
        })
        afterEach(() => fix.teardown())

        // 새 문서를 생성할 때
        describe('when creating a new document', () => {
            // deletedAt을 null로 설정한다
            it('sets deletedAt to null', async () => {
                expect(createdDoc).toMatchObject({ deletedAt: null })
            })
        })

        // 모델 수준 deleteOne을 호출할 때
        describe('when calling Model.deleteOne', () => {
            // deletedAt을 기록한다
            it('records deletedAt', async () => {
                await fix.model.deleteOne({ _id: createdDoc._id })

                const deletedDoc = await fix.model
                    .findOne({ _id: { $eq: createdDoc._id } })
                    .setOptions({ withDeleted: true })
                    .exec()

                expect(deletedDoc?.deletedAt).toEqual(expect.any(Date))
            })
        })

        // 모델 수준 deleteMany를 호출할 때
        describe('when calling Model.deleteMany', () => {
            let secondDoc: HydratedDocument<SoftDeleteSample>

            beforeEach(async () => {
                secondDoc = new fix.model()
                secondDoc.name = 'name'
                await secondDoc.save()
            })

            // 각 문서에 deletedAt을 기록한다
            it('records deletedAt for each document', async () => {
                await fix.model.deleteMany({ _id: { $in: [createdDoc._id, secondDoc._id] } })

                const deletedDocs = await fix.model.find({}).setOptions({ withDeleted: true })
                expect(deletedDocs[0]).toMatchObject({ deletedAt: expect.any(Date) })
                expect(deletedDocs[1]).toMatchObject({ deletedAt: expect.any(Date) })
            })
        })

        // 문서 수준 deleteOne을 호출할 때
        describe('when calling doc.deleteOne (document instance)', () => {
            // deletedAt을 기록한다
            it('records deletedAt', async () => {
                await createdDoc.deleteOne()

                const deletedDoc = await fix.model
                    .findOne({ _id: { $eq: createdDoc._id } })
                    .setOptions({ withDeleted: true })
                    .exec()

                expect(deletedDoc?.deletedAt).toEqual(expect.any(Date))
            })
        })

        // 삭제된 문서가 있을 때의 조회 동작
        describe('when documents are soft-deleted', () => {
            beforeEach(async () => {
                await fix.model.deleteOne({ _id: createdDoc._id })
            })

            // find는 삭제된 문서를 제외한다
            it('find excludes deleted documents', async () => {
                const docs = await fix.model.find({})
                expect(docs).toHaveLength(0)
            })

            // findOne은 삭제된 문서를 제외한다
            it('findOne excludes deleted documents', async () => {
                const doc = await fix.model.findOne({ _id: { $eq: createdDoc._id } })
                expect(doc).toBeNull()
            })

            // findById는 삭제된 문서를 제외한다
            it('findById excludes deleted documents', async () => {
                const doc = await fix.model.findById(createdDoc._id)
                expect(doc).toBeNull()
            })

            // countDocuments는 삭제된 문서를 제외한다
            it('countDocuments excludes deleted documents', async () => {
                const count = await fix.model.countDocuments({})
                expect(count).toBe(0)
            })

            // exists는 삭제된 문서를 제외한다
            it('exists excludes deleted documents', async () => {
                const result = await fix.model.exists({ _id: { $eq: createdDoc._id } })
                expect(result).toBeNull()
            })

            // 집계는 삭제된 문서를 제외한다
            it('aggregate excludes deleted documents', async () => {
                const aggregateResult = await fix.model.aggregate([{ $match: { name: 'name' } }])
                expect(aggregateResult).toHaveLength(0)
            })

            // withDeleted:true는 삭제된 문서를 포함한다
            it('withDeleted option includes deleted documents', async () => {
                const docs = await fix.model.find({}).setOptions({ withDeleted: true })
                expect(docs).toHaveLength(1)
            })
        })

        // 삭제된 문서를 대상으로 한 update 동작
        describe('update operations on soft-deleted documents', () => {
            beforeEach(async () => {
                await fix.model.deleteOne({ _id: createdDoc._id })
            })

            // updateOne은 삭제된 문서를 수정하지 않는다
            it('updateOne does not modify deleted documents', async () => {
                const result = await fix.model.updateOne(
                    { _id: createdDoc._id },
                    { name: 'updated' }
                )
                expect(result.modifiedCount).toBe(0)
            })

            // updateMany는 삭제된 문서를 수정하지 않는다
            it('updateMany does not modify deleted documents', async () => {
                const result = await fix.model.updateMany({}, { name: 'updated' })
                expect(result.modifiedCount).toBe(0)
            })

            // findOneAndUpdate는 삭제된 문서를 반환하지 않는다
            it('findOneAndUpdate returns null for deleted documents', async () => {
                const doc = await fix.model.findOneAndUpdate(
                    { _id: createdDoc._id },
                    { name: 'updated' },
                    { new: true }
                )
                expect(doc).toBeNull()
            })
        })

        // 복원 동작
        describe('restore behavior', () => {
            beforeEach(async () => {
                await fix.model.deleteOne({ _id: createdDoc._id })
            })

            // deletedAt을 null로 복원하면 다시 조회 가능하다
            it('document is queryable again after deletedAt is reset to null', async () => {
                await fix.model
                    .updateOne({ _id: createdDoc._id }, { deletedAt: null })
                    .setOptions({ withDeleted: true })

                const doc = await fix.model.findById(createdDoc._id)
                expect(doc).not.toBeNull()
            })
        })

        // deleteOne 카운트 반환
        describe('deleteOne return value', () => {
            // 삭제된 문서 수를 반환한다
            it('returns deletedCount equal to number of affected documents', async () => {
                const result = await fix.model.deleteOne({ _id: createdDoc._id })
                expect(result).toMatchObject({ deletedCount: 1 })
            })

            // 일치하는 문서가 없으면 0을 반환한다
            it('returns deletedCount 0 when no document matches', async () => {
                await fix.model.deleteOne({ _id: createdDoc._id })
                const result = await fix.model.deleteOne({ _id: createdDoc._id })
                expect(result).toMatchObject({ deletedCount: 0 })
            })
        })

        // findOneAndDelete 동작
        describe('findOneAndDelete', () => {
            // deletedAt만 기록하고 물리적으로 삭제하지 않는다
            it('performs soft delete, not hard delete', async () => {
                await fix.model.findOneAndDelete({ _id: createdDoc._id })

                const deletedDoc = await fix.model
                    .findOne({ _id: { $eq: createdDoc._id } })
                    .setOptions({ withDeleted: true })
                    .exec()

                expect(deletedDoc?.deletedAt).toEqual(expect.any(Date))
            })
        })

        // distinct 동작
        describe('distinct on soft-deleted documents', () => {
            beforeEach(async () => {
                await fix.model.deleteOne({ _id: createdDoc._id })
            })

            // 삭제된 문서의 값은 결과에 포함되지 않는다
            it('excludes values from deleted documents', async () => {
                const names = await fix.model.distinct('name')
                expect(names).toEqual([])
            })
        })

        // 이미 삭제된 문서에 대한 중복 삭제
        describe('deleting an already-deleted document', () => {
            beforeEach(async () => {
                await fix.model.deleteOne({ _id: createdDoc._id })
            })

            // deletedAt이 재설정되지 않는다 (idempotency)
            it('does not overwrite deletedAt on second delete', async () => {
                const firstDoc = await fix.model
                    .findOne({ _id: { $eq: createdDoc._id } })
                    .setOptions({ withDeleted: true })
                    .exec()
                const firstDeletedAt = firstDoc?.deletedAt

                await fix.model.deleteOne({ _id: createdDoc._id })

                const secondDoc = await fix.model
                    .findOne({ _id: { $eq: createdDoc._id } })
                    .setOptions({ withDeleted: true })
                    .exec()

                expect(secondDoc?.deletedAt).toEqual(firstDeletedAt)
            })
        })

        // insertMany로 생성 시 deletedAt
        describe('insertMany', () => {
            // 각 새 문서의 deletedAt이 null이다
            it('sets deletedAt to null for each inserted document', async () => {
                await fix.model.insertMany([{ name: 'a' }, { name: 'b' }])

                const docs = await fix.model.find({})
                expect(docs).toHaveLength(3) // createdDoc + 2 new
                expect(docs.every((d) => d.deletedAt === null)).toBe(true)
            })
        })

        // bulkWrite 동작
        describe('bulkWrite on soft-deleted documents', () => {
            beforeEach(async () => {
                await fix.model.deleteOne({ _id: createdDoc._id })
            })

            // updateOne in bulkWrite는 삭제된 문서를 수정하지 않는다
            it('updateOne does not modify deleted documents', async () => {
                const result = await fix.model.bulkWrite([
                    { updateOne: { filter: { _id: createdDoc._id }, update: { name: 'updated' } } }
                ])
                expect(result.modifiedCount).toBe(0)
            })

            // updateMany in bulkWrite는 삭제된 문서를 수정하지 않는다
            it('updateMany does not modify deleted documents', async () => {
                const result = await fix.model.bulkWrite([
                    { updateMany: { filter: {}, update: { name: 'updated' } } }
                ])
                expect(result.modifiedCount).toBe(0)
            })

            // replaceOne in bulkWrite는 삭제된 문서를 교체하지 않는다
            it('replaceOne does not modify deleted documents', async () => {
                const result = await fix.model.bulkWrite([
                    {
                        replaceOne: {
                            filter: { _id: createdDoc._id },
                            replacement: { name: 'replaced' } as SoftDeleteSample
                        }
                    }
                ])
                expect(result.modifiedCount).toBe(0)
            })

            // deleteOne in bulkWrite는 softDelete로 동작한다
            it('deleteOne performs soft delete, not hard delete', async () => {
                // 새 문서 생성 (createdDoc는 이미 삭제됨)
                const liveDoc = await fix.model.create({ name: 'live' })

                await fix.model.bulkWrite([{ deleteOne: { filter: { _id: liveDoc._id } } }])

                const doc = await fix.model
                    .findOne({ _id: { $eq: liveDoc._id } })
                    .setOptions({ withDeleted: true })
                    .exec()
                expect(doc?.deletedAt).toEqual(expect.any(Date))
            })

            // deleteMany in bulkWrite는 softDelete로 동작한다
            it('deleteMany performs soft delete, not hard delete', async () => {
                const liveDoc1 = await fix.model.create({ name: 'live1' })
                const liveDoc2 = await fix.model.create({ name: 'live2' })

                await fix.model.bulkWrite([
                    { deleteMany: { filter: { name: { $in: ['live1', 'live2'] } } } }
                ])

                const docs = await fix.model
                    .find({ _id: { $in: [liveDoc1._id, liveDoc2._id] } })
                    .setOptions({ withDeleted: true })
                expect(docs).toHaveLength(2)
                expect(docs.every((d) => d.deletedAt instanceof Date)).toBe(true)
            })
        })

        // findOneAndReplace가 삭제된 문서를 대체하지 않는다
        describe('findOneAndReplace on soft-deleted documents', () => {
            beforeEach(async () => {
                await fix.model.deleteOne({ _id: createdDoc._id })
            })

            // 삭제된 문서를 반환하거나 대체하지 않는다
            it('returns null for deleted documents', async () => {
                const doc = await fix.model.findOneAndReplace(
                    { _id: createdDoc._id },
                    { name: 'replaced' },
                    { returnDocument: 'after' }
                )
                expect(doc).toBeNull()
            })
        })

        // Save 후 생성된 문서의 deletedAt 기본값
        describe('Model.create with soft delete', () => {
            // create로 생성된 문서도 deletedAt이 null이다
            it('sets deletedAt to null', async () => {
                const doc = await fix.model.create({ name: 'created' })
                expect(doc.deletedAt).toBeNull()
            })
        })

        // 삭제된 문서에 save 호출 시 동작 - 복원처럼 작동해야 함
        describe('save on document loaded with withDeleted', () => {
            beforeEach(async () => {
                await fix.model.deleteOne({ _id: createdDoc._id })
            })

            // deletedAt을 null로 설정하고 save하면 복원된다
            it('restores document when deletedAt is set to null and saved', async () => {
                const deletedDoc = await fix.model
                    .findOne({ _id: { $eq: createdDoc._id } })
                    .setOptions({ withDeleted: true })
                    .exec()

                if (!deletedDoc) throw new Error('deletedDoc must exist')

                deletedDoc.deletedAt = null
                await deletedDoc.save()

                const restored = await fix.model.findById(createdDoc._id)
                expect(restored).not.toBeNull()
            })
        })

        // 고유 인덱스와 softDelete 의 상호작용
        describe('unique index interaction with soft delete', () => {
            // 삭제된 문서와 같은 unique 값으로 새 문서 생성이 가능한가?
            // 현재: unique index는 collection 전체(삭제 포함)에 적용되므로 실패한다
            // 이건 documented limitation. 애플리케이션이 필요시 partial index를 써야 함.
            it('unique index still applies to soft-deleted documents (documented limitation)', async () => {
                await fix.model.collection.createIndex({ name: 1 }, { unique: true })
                await fix.model.deleteOne({ _id: createdDoc._id })

                // 같은 name 으로 create 시도 → unique 위반 에러
                await expect(fix.model.create({ name: 'name' })).rejects.toThrow(/duplicate key/i)
            })
        })

        // 명시적 deletedAt 조건을 포함한 쿼리
        describe('explicit deletedAt query', () => {
            beforeEach(async () => {
                await fix.model.deleteOne({ _id: createdDoc._id })
            })

            // withDeleted 없이 명시적으로 deletedAt 조회하면 middleware가 덮어씀
            it('find with explicit deletedAt filter is still filtered by middleware without withDeleted', async () => {
                // deletedAt !== null 로 찾으려 해도 middleware가 덮어씀
                const docs = await fix.model.find({ deletedAt: { $ne: null } })
                expect(docs).toHaveLength(0)
            })

            // withDeleted:true + 명시적 deletedAt 필터는 그대로 동작
            it('withDeleted+explicit deletedAt query works as expected', async () => {
                const docs = await fix.model
                    .find({ deletedAt: { $ne: null } })
                    .setOptions({ withDeleted: true })
                expect(docs).toHaveLength(1)
            })
        })
    })

    describe('Hard Delete', () => {
        let fix: CrudDeleteFixture<HardDeleteSample>
        let createdDoc: HydratedDocument<HardDeleteSample>

        beforeEach(async () => {
            const { createCrudDeleteFixture } = await import('./crud-delete.fixture')
            fix = await createCrudDeleteFixture(HardDeleteSample)

            createdDoc = new fix.model()
            createdDoc.name = 'name'
            await createdDoc.save()
        })
        afterEach(() => fix.teardown())

        // 새 문서를 생성할 때
        describe('when creating a new document', () => {
            // deletedAt이 존재하지 않는다
            it('does not have deletedAt', async () => {
                expect(createdDoc).not.toHaveProperty('deletedAt')
            })
        })

        // deleteOne은 문서를 실제로 삭제한다
        describe('when calling deleteOne', () => {
            // 문서가 DB에서 제거된다
            it('removes the document from DB', async () => {
                await fix.model.deleteOne({ _id: createdDoc._id })
                const doc = await fix.model.findById(createdDoc._id)
                expect(doc).toBeNull()
            })
        })
    })
})
