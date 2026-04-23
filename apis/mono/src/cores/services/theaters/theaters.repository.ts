import {
    QueryBuilderOptions,
    assignIfDefined,
    CrudRepository,
    QueryBuilder
} from '@mannercode/common'
import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { MongooseConfigModule } from 'config'
import { Model } from 'mongoose'
import { CreateTheaterDto, SearchTheatersPageDto, UpdateTheaterDto } from './dtos'
import { Theater } from './models'

@Injectable()
export class TheatersRepository extends CrudRepository<Theater> {
    constructor(
        @InjectModel(Theater.name, MongooseConfigModule.connectionName)
        readonly model: Model<Theater>
    ) {
        super(model, MongooseConfigModule.maxTake)
    }

    async create(createDto: CreateTheaterDto) {
        const theater = this.newDocument()
        theater.name = createDto.name
        theater.location = createDto.location
        theater.seatmap = createDto.seatmap
        await theater.save()

        return theater.toJSON()
    }

    async searchPage(searchDto: SearchTheatersPageDto) {
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

    async update(theaterId: string, updateDto: UpdateTheaterDto) {
        const theater = await this.getDocumentById(theaterId)
        assignIfDefined(theater, updateDto, 'name')
        assignIfDefined(theater, updateDto, 'location')
        assignIfDefined(theater, updateDto, 'seatmap')
        await theater.save()

        return theater.toJSON()
    }

    private buildQuery(searchDto: SearchTheatersPageDto, options: QueryBuilderOptions) {
        const { name } = searchDto

        const builder = new QueryBuilder<Theater>()
        // cycle-31 에서 substring + case-insensitive 원복. cycle-10/12 에서
        // prefix+caseSensitive 로 전환했었지만 사용자가 substring 매칭이
        // 필수 요건임을 확인 — 기능(API 계약) 보호가 성능보다 우선.
        // compound index 는 남겨둠 (substring regex 는 활용 못 해도 harm 없음,
        // 다른 쿼리 경로에 잠재 활용 가능).
        builder.addRegex('name', name)

        const query = builder.build(options)
        return query
    }
}
