import { QueryBuilderOptions, CrudRepository, QueryBuilder, leanToPublic } from '@mannercode/common'
import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { MongooseConfigModule } from 'config'
import { Model } from 'mongoose'
import { CreateShowtimeDto, SearchShowtimesDto } from './dtos'
import { Showtime } from './models'

@Injectable()
export class ShowtimesRepository extends CrudRepository<Showtime> {
    constructor(
        @InjectModel(Showtime.name, MongooseConfigModule.connectionName)
        readonly model: Model<Showtime>
    ) {
        super(model, MongooseConfigModule.maxTake)
    }

    async deleteBySagaIds(sagaIds: string[]) {
        await this.model.deleteMany({ sagaId: { $in: sagaIds } })
    }

    async createMany(createDtos: CreateShowtimeDto[]) {
        const showtimes = createDtos.map((dto) => {
            const doc = this.newDocument()
            doc.sagaId = dto.sagaId
            doc.movieId = dto.movieId
            doc.theaterId = dto.theaterId
            doc.startTime = dto.startTime
            doc.endTime = dto.endTime

            return doc
        })

        await this.saveMany(showtimes)
    }

    async search(searchDto: SearchShowtimesDto) {
        const query = this.buildQuery(searchDto)

        // cycle-19: mongoose-lean-virtuals 플러그인 제거 (cycle-06 패턴 복제).
        // lean 결과에 leanToPublic 로 `_id → id` 매핑. 플러그인 hook 오버헤드
        // 없이 동일한 공개 `id: string` 계약 유지.
        const showtimes = await this.model.find(query).sort({ startTime: 1 }).lean().exec()
        return (showtimes as any[]).map(leanToPublic) as typeof showtimes
    }

    async searchMovieIds(searchDto: SearchShowtimesDto) {
        const query = this.buildQuery(searchDto)

        const movieIds = await this.model.distinct('movieId', query).exec()
        return movieIds.map((id) => id.toString())
    }

    async searchShowdates(searchDto: SearchShowtimesDto) {
        const query = this.buildQuery(searchDto)

        const showdates = await this.model.aggregate([
            { $match: query },
            { $project: { date: { $dateToString: { date: '$startTime', format: '%Y-%m-%d' } } } },
            { $group: { _id: '$date' } },
            { $sort: { _id: 1 } }
        ])

        return showdates.map((item) => new Date(item._id))
    }

    async searchTheaterIds(searchDto: SearchShowtimesDto) {
        const query = this.buildQuery(searchDto)

        const theaterIds = await this.model.distinct('theaterId', query).exec()
        return theaterIds.map((id) => id.toString())
    }

    private buildQuery(searchDto: SearchShowtimesDto, options: QueryBuilderOptions = {}) {
        const { endTimeRange, movieIds, sagaIds, startTimeRange, theaterIds } = searchDto

        const builder = new QueryBuilder<Showtime>()
        builder.addIn('sagaId', sagaIds)
        builder.addIn('movieId', movieIds)
        builder.addIn('theaterId', theaterIds)
        builder.addRange('startTime', startTimeRange)
        builder.addRange('endTime', endTimeRange)

        const query = builder.build(options)
        return query
    }
}
