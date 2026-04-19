import { DateTimeRange, DateUtil, Require, TimeUtil } from '@mannercode/common'
import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Rules } from 'config'
import { MoviesClient, ShowtimeDto, ShowtimesClient, TheatersClient } from 'cores'
import { BulkCreateShowtimesDto } from '../dtos'
import { ShowtimeCreationErrors } from '../errors'

type TimeslotMap = Map<number, ShowtimeDto>

const iterateTimeslots = (
    timeRange: DateTimeRange,
    onTimeslot: (timeslot: number) => boolean | void
) => {
    for (
        let timeslot = timeRange.start.getTime();
        timeslot <= timeRange.end.getTime();
        timeslot = timeslot + TimeUtil.toMs(`${Rules.Showtime.timeslotInMinutes}m`)
    ) {
        if (false === onTimeslot(timeslot)) {
            break
        }
    }
}

@Injectable()
export class ShowtimeBulkValidatorService {
    private readonly logger = new Logger(ShowtimeBulkValidatorService.name)

    constructor(
        private readonly theatersClient: TheatersClient,
        private readonly moviesClient: MoviesClient,
        private readonly showtimesClient: ShowtimesClient
    ) {}

    async validate(createDto: BulkCreateShowtimesDto) {
        await this.verifyMovieExists(createDto.movieId)
        await this.verifyTheatersExist(createDto.theaterIds)

        const conflictingShowtimes = await this.findConflictingShowtimes(createDto)

        this.logger.log('validate completed', {
            movieId: createDto.movieId,
            theaterCount: createDto.theaterIds.length,
            conflictCount: conflictingShowtimes.length
        })

        return { conflictingShowtimes, isValid: 0 === conflictingShowtimes.length }
    }

    private async findConflictingShowtimes(createDto: BulkCreateShowtimesDto) {
        const { durationInMinutes, startTimes, theaterIds } = createDto

        const timeslotsByTheater = await this.generateTimeslotMapByTheater(createDto)

        const conflictingShowtimes: ShowtimeDto[] = []

        for (const theaterId of theaterIds) {
            const timeslots = timeslotsByTheater.get(theaterId)

            Require.defined(timeslots, `Timeslots must be defined for theater ID: ${theaterId}`)

            for (const start of startTimes) {
                const timeRange = DateTimeRange.create({ minutes: durationInMinutes, start })

                iterateTimeslots(timeRange, (timeslot) => {
                    const showtime = timeslots.get(timeslot)

                    if (showtime) {
                        conflictingShowtimes.push(showtime)
                        return false
                    }

                    return true
                })
            }
        }

        return conflictingShowtimes
    }

    private async generateTimeslotMapByTheater(createDto: BulkCreateShowtimesDto) {
        const { durationInMinutes, startTimes, theaterIds } = createDto

        const startDate = DateUtil.earliest(startTimes)
        const maxDate = DateUtil.latest(startTimes)
        const endDate = DateUtil.add({ base: maxDate, minutes: durationInMinutes })

        const timeslotsByTheater = new Map<string, TimeslotMap>()

        for (const theaterId of theaterIds) {
            const fetchedShowtimes = await this.showtimesClient.search({
                startTimeRange: { end: endDate, start: startDate },
                theaterIds: [theaterId]
            })

            const timeslots = new Map<number, ShowtimeDto>()

            for (const showtime of fetchedShowtimes) {
                const { endTime: end, startTime: start } = showtime

                iterateTimeslots({ end, start }, (timeslot) => {
                    timeslots.set(timeslot, showtime)
                })
            }

            timeslotsByTheater.set(theaterId, timeslots)
        }

        return timeslotsByTheater
    }

    private async verifyMovieExists(movieId: string) {
        const movieExists = await this.moviesClient.allExist([movieId])

        if (!movieExists) {
            throw new NotFoundException(ShowtimeCreationErrors.MovieNotFound(movieId))
        }
    }

    private async verifyTheatersExist(theaterIds: string[]) {
        const theatersExist = await this.theatersClient.allExist(theaterIds)

        if (!theatersExist) {
            throw new NotFoundException(ShowtimeCreationErrors.TheatersNotFound(theaterIds))
        }
    }
}
