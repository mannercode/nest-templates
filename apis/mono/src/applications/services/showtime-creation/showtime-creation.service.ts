import { PaginationDto, OrderDirection } from '@mannercode/common'
import { Injectable } from '@nestjs/common'
import { MoviesService, ShowtimesService, TheatersService } from 'cores'
import { BulkCreateShowtimesDto, RequestShowtimeCreationResponse } from './dtos'
import { ShowtimeCreationWorkerService } from './services'

@Injectable()
export class ShowtimeCreationService {
    constructor(
        private readonly theatersService: TheatersService,
        private readonly moviesService: MoviesService,
        private readonly showtimesService: ShowtimesService,
        private readonly workerService: ShowtimeCreationWorkerService
    ) {}

    async requestShowtimeCreation(
        createDto: BulkCreateShowtimesDto
    ): Promise<RequestShowtimeCreationResponse> {
        const sagaId = await this.workerService.enqueueShowtimeCreationJob(createDto)

        return { sagaId }
    }

    async searchMoviesPage(searchDto: PaginationDto) {
        return this.moviesService.searchPage({
            ...searchDto,
            orderby: { direction: OrderDirection.Desc, name: 'releaseDate' }
        })
    }

    async searchShowtimes(theaterIds: string[]) {
        return this.showtimesService.search({ endTimeRange: { start: new Date() }, theaterIds })
    }

    async searchTheatersPage(searchDto: PaginationDto) {
        return this.theatersService.searchPage(searchDto)
    }
}
