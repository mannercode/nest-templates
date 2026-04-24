import {
    QueryBuilderOptions,
    CrudRepository,
    objectIds,
    QueryBuilder,
    leanToPublic
} from '@mannercode/common'
import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { MongooseConfigModule } from 'config'
import { Model } from 'mongoose'
import {
    AggregateTicketSalesDto,
    CreateTicketDto,
    SearchTicketsDto,
    TicketSalesForShowtimeDto
} from './dtos'
import { Ticket, TicketStatus } from './models'

@Injectable()
export class TicketsRepository extends CrudRepository<Ticket> {
    constructor(
        @InjectModel(Ticket.name, MongooseConfigModule.connectionName) readonly model: Model<Ticket>
    ) {
        super(model, MongooseConfigModule.maxTake)
    }

    async deleteBySagaIds(sagaIds: string[]) {
        await this.model.deleteMany({ sagaId: { $in: sagaIds } })
    }

    async aggregateSales(aggregateDto: AggregateTicketSalesDto) {
        const query = this.buildQuery(aggregateDto)

        const showtimeTicketSalesArray = await this.model.aggregate([
            { $match: query },
            {
                $group: {
                    _id: '$showtimeId',
                    sold: { $sum: { $cond: [{ $eq: ['$status', TicketStatus.Sold] }, 1, 0] } },
                    total: { $sum: 1 }
                }
            },
            {
                $project: {
                    _id: 0,
                    available: { $subtract: ['$total', '$sold'] },
                    showtimeId: { $toString: '$_id' },
                    sold: 1,
                    total: 1
                }
            }
        ])

        return showtimeTicketSalesArray as TicketSalesForShowtimeDto[]
    }

    async createMany(createDtos: CreateTicketDto[]) {
        const tickets = createDtos.map((dto) => {
            const ticket = this.newDocument()
            ticket.sagaId = dto.sagaId
            ticket.movieId = dto.movieId
            ticket.theaterId = dto.theaterId
            ticket.showtimeId = dto.showtimeId
            ticket.status = dto.status
            ticket.seat = dto.seat

            return ticket
        })

        await this.saveMany(tickets)
    }

    async search(searchDto: SearchTicketsDto) {
        const query = this.buildQuery(searchDto)

        // cycle-19: lean-virtuals 플러그인 제거 + leanToPublic (cycle-06 패턴).
        const tickets = await this.model.find(query).sort({ sagaId: 1 }).lean().exec()
        return (tickets as any[]).map(leanToPublic) as typeof tickets
    }

    async updateStatusMany(ticketIds: string[], status: TicketStatus) {
        const result = await this.model.updateMany(
            { _id: { $in: objectIds(ticketIds) } },
            { $set: { status } }
        )

        return result
    }

    private buildQuery(searchDto: SearchTicketsDto, options: QueryBuilderOptions = {}) {
        const { movieIds, sagaIds, showtimeIds, theaterIds } = searchDto

        const builder = new QueryBuilder<Ticket>()
        builder.addIn('sagaId', sagaIds)
        builder.addIn('movieId', movieIds)
        builder.addIn('theaterId', theaterIds)
        builder.addIn('showtimeId', showtimeIds)

        const query = builder.build(options)
        return query
    }
}
