import { QueryBuilderOptions, CrudRepository, QueryBuilder } from '@mannercode/common'
import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { MongooseConfigModule } from 'config'
import { Model } from 'mongoose'
import { CreateWatchRecordDto, SearchWatchRecordsPageDto } from './dtos'
import { WatchRecord } from './models'

@Injectable()
export class WatchRecordsRepository extends CrudRepository<WatchRecord> {
    constructor(
        @InjectModel(WatchRecord.name, MongooseConfigModule.connectionName)
        readonly model: Model<WatchRecord>
    ) {
        super(model, MongooseConfigModule.maxTake)
    }

    async create(createDto: CreateWatchRecordDto) {
        const watchRecord = this.newDocument()
        watchRecord.customerId = createDto.customerId
        watchRecord.movieId = createDto.movieId
        watchRecord.purchaseRecordId = createDto.purchaseRecordId
        watchRecord.watchDate = createDto.watchDate

        await watchRecord.save()

        return watchRecord.toJSON()
    }

    async searchPage(searchDto: SearchWatchRecordsPageDto) {
        const { orderby, page, size } = searchDto

        const pagination = await this.findWithPagination({
            configureQuery: async (queryHelper) => {
                const query = this.buildQuery(searchDto, { allowEmpty: true })

                queryHelper.setQuery(query)
            },
            pagination: { orderby, page, size }
        })

        return pagination
    }

    private buildQuery(searchDto: SearchWatchRecordsPageDto, options: QueryBuilderOptions) {
        const { customerId } = searchDto

        const builder = new QueryBuilder<WatchRecord>()
        builder.addEquals('customerId', customerId)

        const query = builder.build(options)
        return query
    }
}
