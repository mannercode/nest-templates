import type {
    ClientSession,
    HydratedDocument,
    Model,
    ObjectId,
    QueryFilter,
    QueryWithHelpers
} from 'mongoose'
import { BadRequestException, NotFoundException, OnModuleInit } from '@nestjs/common'
import type { PaginationDto, PaginationResult } from '../pagination'
import { defaultTo, differenceWith, uniq } from '../utils'
import { Require, Verify } from '../validator'
import { MongooseErrors } from './errors'
import { objectId, objectIds } from './mongoose.util'

type BulkSaveDocs<Doc> = Parameters<Model<Doc>['bulkSave']>[0]
type SessionArg = ClientSession | undefined

const defaultLeanOptions = { virtuals: true }

/**
 * CRUD category 의 repository base.
 *
 * 일반적인 도메인 엔티티의 CRUD 동작 (find, save, delete, paginate, transaction) 을
 * 제공한다. Append-only category (audit log 등) 는 본 base 가 아니라
 * `AppendOnlyRepository` 를 사용한다 — delete/update 메서드를 타입에서 노출하지 않음.
 */
export abstract class CrudRepository<Doc> implements OnModuleInit {
    constructor(
        protected readonly model: Model<Doc>,
        protected readonly maxSize: number
    ) {}

    async deleteById(id: string, session: SessionArg = undefined) {
        const doc = await this.getDocumentById(id, session)
        await doc.deleteOne({ session })
    }

    async deleteByIds(ids: string[], session: SessionArg = undefined) {
        const { deletedCount } = await this.model.deleteMany(
            { _id: { $in: objectIds(ids) } } as QueryFilter<Doc>,
            { session }
        )

        return { deletedCount }
    }

    async allExist(ids: string[], session: SessionArg = undefined) {
        const uniqueIds = uniq(ids)
        if (uniqueIds.length === 0) return true

        const count = await this.model.countDocuments(
            { _id: { $in: objectIds(uniqueIds) } } as QueryFilter<Doc>,
            { session }
        )
        return count === uniqueIds.length
    }

    async findById(id: string, session: SessionArg = undefined) {
        const doc = await this.model
            .findById(objectId(id), null, { session })
            .lean(defaultLeanOptions)

        return doc as Doc | null
    }

    async findByIds(ids: string[], session: SessionArg = undefined): Promise<Doc[]> {
        const docs = await this.model
            .find({ _id: { $in: objectIds(ids) } } as QueryFilter<Doc>, null, { session })
            .lean(defaultLeanOptions)

        return docs
    }

    async findWithPagination(args: {
        configureQuery?: (queryHelper: QueryWithHelpers<Array<Doc>, Doc>) => Promise<void>
        pagination: PaginationDto
        session?: SessionArg
    }) {
        const { configureQuery, pagination, session } = args

        const size = defaultTo(pagination.size, this.maxSize)
        const page = defaultTo(pagination.page, 1)

        if (size <= 0) {
            throw new BadRequestException(MongooseErrors.SizeInvalid(size))
        } else if (this.maxSize < size) {
            throw new BadRequestException(MongooseErrors.MaxSizeExceeded(this.maxSize, size))
        }

        const skip = (page - 1) * size

        const queryHelper = this.model.find({}, null, { session })
        queryHelper.limit(size)
        queryHelper.skip(skip)

        if (pagination.orderby) {
            const { direction, name } = pagination.orderby
            queryHelper.sort({ [name]: direction })
        }

        if (configureQuery) {
            await configureQuery(queryHelper)
        }

        queryHelper.lean(defaultLeanOptions)

        const [items, total] = await Promise.all([
            queryHelper.exec(),
            this.model.countDocuments(queryHelper.getQuery()).exec()
        ])

        return { items, page, size, total } as PaginationResult<Doc>
    }

    async getById(id: string, session: SessionArg = undefined) {
        const doc = await this.findById(id, session)

        if (!doc) {
            throw new NotFoundException(MongooseErrors.DocumentNotFound(id))
        }

        return doc
    }

    async getByIds(ids: string[], session: SessionArg = undefined) {
        const uniqueIds = uniq(ids)

        Verify.equalLength(uniqueIds, ids, `Duplicate IDs detected and removed:${ids}`)

        const docs = await this.findByIds(uniqueIds, session)

        const notFoundIds = differenceWith(
            uniqueIds,
            docs,
            (id, doc) => id === (doc as { _id: ObjectId })._id.toString()
        )

        if (notFoundIds.length > 0) {
            throw new NotFoundException(MongooseErrors.MultipleDocumentsNotFound(notFoundIds))
        }

        return docs
    }

    newDocument(): HydratedDocument<Doc> {
        return new this.model()
    }

    async onModuleInit() {
        /**
         * Since document.save() internally calls createCollection(),
         * calling save() at the same time can cause a "Collection namespace is already in use" error.
         * This issue often occurs in unit test environments due to frequent re-initialization.
         *
         * document.save()가 내부적으로 createCollection()을 호출한다.
         * 동시에 save()를 호출하면 "Collection namespace is already in use" 오류가 발생할 수 있다.
         * 이 문제는 주로 단위 테스트 환경에서 빈번한 초기화로 인해 발생한다.
         *
         * https://mongoosejs.com/docs/api/model.html#Model.createCollection()
         */
        await this.model.createCollection()
        await this.model.createIndexes()
    }

    async saveMany(docs: BulkSaveDocs<Doc>, session: SessionArg = undefined): Promise<void> {
        const { deletedCount, insertedCount, matchedCount } = await this.model.bulkSave(docs, {
            session
        })

        Require.equals(
            docs.length,
            insertedCount + matchedCount + deletedCount,
            `The number of inserted documents should match the requested count`
        )
    }

    async withTransaction<T>(
        callback: (session: ClientSession, rollback: () => void) => Promise<T>
    ) {
        const state = { rollbackRequested: false }
        const rollback = () => {
            state.rollbackRequested = true
        }

        let session: ClientSession | undefined

        try {
            session = await this.model.startSession()
            session.startTransaction()

            const result = await callback(session, rollback)
            return result
        } catch (error) {
            rollback()
            throw error
        } finally {
            if (session) {
                if (session.inTransaction()) {
                    if (state.rollbackRequested) {
                        await session.abortTransaction()
                    } else {
                        await session.commitTransaction()
                    }
                }
                await session.endSession()
            }
        }
    }

    protected async findDocumentById(id: string, session: SessionArg = undefined) {
        const doc = await this.model.findById(objectId(id), null, { session })

        return doc
    }

    protected async getDocumentById(id: string, session: SessionArg = undefined) {
        const doc = await this.findDocumentById(id, session)

        if (!doc) {
            throw new NotFoundException(MongooseErrors.DocumentNotFound(id))
        }

        return doc
    }
}
