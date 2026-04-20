import type { MovieDto, ShowtimeDto, TheaterDto } from 'cores'
import { DateUtil } from '@mannercode/common'
import { nullObjectId, Response } from '@mannercode/testing'
import { createMovie, createShowtimes, createTheater } from '../__helpers__'
import { waitForCompletion, ShowtimeCreationFixture } from './showtime-creation.fixture'

describe('ShowtimeCreationService', () => {
    let fix: ShowtimeCreationFixture
    let movie: MovieDto
    let theater: TheaterDto

    beforeEach(async () => {
        const { createShowtimeCreationFixture } = await import('./showtime-creation.fixture')
        fix = await createShowtimeCreationFixture()

        movie = await createMovie(fix)
        theater = await createTheater(fix)
    })
    afterEach(() => fix.teardown())

    describe('GET /showtime-creation/movies', () => {
        // 쿼리가 제공되지 않을 때
        describe('when the query is not provided', () => {
            // 기본 영화 페이지를 반환한다
            it('returns the default page of movies', async () => {
                await fix.httpClient
                    .get('/showtime-creation/movies')
                    .ok({
                        items: [movie],
                        page: expect.any(Number),
                        size: expect.any(Number),
                        total: 1
                    })
            })
        })
    })

    describe('GET /showtime-creation/theaters', () => {
        // 쿼리가 제공되지 않을 때
        describe('when the query is not provided', () => {
            // 기본 극장 페이지를 반환한다
            it('returns the default page of theaters', async () => {
                await fix.httpClient
                    .get('/showtime-creation/theaters')
                    .ok({
                        items: [theater],
                        page: expect.any(Number),
                        size: expect.any(Number),
                        total: 1
                    })
            })
        })
    })

    describe('POST /showtime-creation/showtimes/search', () => {
        // 극장에 대한 상영 시간이 존재할 때
        describe('when showtimes exist for the theater', () => {
            let showtimes: ShowtimeDto[]

            beforeEach(async () => {
                showtimes = await createShowtimes(
                    fix,
                    [
                        new Date('2100-01-01T09:00'),
                        new Date('2100-01-01T11:00'),
                        new Date('2100-01-01T13:00')
                    ].map((startTime) => ({ startTime, theaterId: theater.id }))
                )
            })

            // theaterIds에 대한 상영 시간을 반환한다
            it('returns showtimes for the theaterIds', async () => {
                await fix.httpClient
                    .post('/showtime-creation/showtimes/search')
                    .body({ theaterIds: [theater.id] })
                    .ok(expect.arrayContaining(showtimes))
            })
        })
    })

    describe('POST /showtime-creation/showtimes', () => {
        // 상영 시간 생성이 요청될 때
        describe('when showtime creation is requested', () => {
            let createPromise: Promise<Response>

            beforeEach(async () => {
                createPromise = fix.httpClient
                    .post('/showtime-creation/showtimes')
                    .body({
                        durationInMinutes: 1,
                        movieId: movie.id,
                        startTimes: [new Date('2100-01-01T09:00')],
                        theaterIds: [theater.id]
                    })
                    .accepted()
            })

            // sagaId를 반환한다
            it('returns a sagaId', async () => {
                const { body } = await createPromise
                expect(body).toEqual(expect.objectContaining({ sagaId: expect.any(String) }))
            })

            // 사가 상태 업데이트를 스트리밍한다
            it('streams saga status updates', async () => {
                const eventPromise = new Promise((resolve, reject) => {
                    fix.httpClient.get('/showtime-creation/event-stream').sse((data) => {
                        const statusUpdate = JSON.parse(data)

                        if (['error', 'failed', 'succeeded'].includes(statusUpdate.status)) {
                            fix.httpClient.abort()

                            if ('succeeded' === statusUpdate.status) {
                                resolve(statusUpdate)
                            } else {
                                reject(statusUpdate)
                            }
                        }
                    }, reject)
                })

                const { body } = await createPromise

                await expect(eventPromise).resolves.toEqual(
                    expect.objectContaining({ sagaId: body.sagaId, status: 'succeeded' })
                )
            })

            // 상영 시간을 생성한다
            it('creates showtimes', async () => {
                const { body } = await createPromise
                const { createdShowtimeCount } = await waitForCompletion(fix, 'succeeded')

                const createdShowtimes = await fix.showtimesService.search({
                    sagaIds: [body.sagaId]
                })
                expect(createdShowtimes).toHaveLength(createdShowtimeCount)
            })

            // 티켓을 생성한다
            it('creates tickets', async () => {
                const { body } = await createPromise
                const { createdTicketCount } = await waitForCompletion(fix, 'succeeded')

                const createdTickets = await fix.ticketsService.search({ sagaIds: [body.sagaId] })
                expect(createdTickets).toHaveLength(createdTicketCount)
            })
        })

        // 영화가 존재하지 않을 때
        describe('when the movie does not exist', () => {
            // 오류를 보고한다
            it('reports an error', async () => {
                const completionPromise = waitForCompletion(fix, 'error')

                const { body } = await fix.httpClient
                    .post('/showtime-creation/showtimes')
                    .body({
                        durationInMinutes: 1,
                        movieId: nullObjectId,
                        startTimes: [new Date(0)],
                        theaterIds: [theater.id]
                    })
                    .accepted()

                await expect(completionPromise).resolves.toEqual({
                    message: 'The requested movie could not be found.',
                    sagaId: body.sagaId,
                    status: 'error'
                })
            })
        })

        // 극장이 존재하지 않을 때
        describe('when the theater does not exist', () => {
            // 오류를 보고한다
            it('reports an error', async () => {
                const completionPromise = waitForCompletion(fix, 'error')

                const { body } = await fix.httpClient
                    .post('/showtime-creation/showtimes')
                    .body({
                        durationInMinutes: 1,
                        movieId: movie.id,
                        startTimes: [new Date(0)],
                        theaterIds: [nullObjectId]
                    })
                    .accepted()

                await expect(completionPromise).resolves.toEqual({
                    message: 'One or more requested theaters could not be found.',
                    sagaId: body.sagaId,
                    status: 'error'
                })
            })
        })

        // 상영 시간이 충돌할 때
        describe('when showtimes conflict', () => {
            let initialShowtimes: ShowtimeDto[]

            beforeEach(async () => {
                initialShowtimes = await createShowtimes(
                    fix,
                    [
                        new Date('2013-01-31T12:00'),
                        new Date('2013-01-31T14:00'),
                        new Date('2013-01-31T16:30'),
                        new Date('2013-01-31T18:30')
                    ].map((startTime) => ({
                        endTime: DateUtil.add({ base: startTime, minutes: 90 }),
                        startTime,
                        theaterId: theater.id
                    }))
                )
            })

            // 충돌하는 상영 시간을 반환한다
            it('returns the conflicting showtimes', async () => {
                const completionPromise = waitForCompletion(fix, 'failed')

                await fix.httpClient
                    .post('/showtime-creation/showtimes')
                    .body({
                        durationInMinutes: 30,
                        movieId: movie.id,
                        startTimes: [
                            new Date('2013-01-31T12:00'),
                            new Date('2013-01-31T16:00'),
                            new Date('2013-01-31T20:00')
                        ],
                        theaterIds: [theater.id]
                    })
                    .accepted()

                const conflictingShowtimes = [
                    initialShowtimes[0],
                    initialShowtimes[2],
                    initialShowtimes[3]
                ]

                await expect(completionPromise).resolves.toEqual({
                    conflictingShowtimes,
                    sagaId: expect.any(String),
                    status: 'failed'
                })
            })
        })

        // 기존 상영 시간이 새 범위보다 먼저 시작하지만 겹치는 경우
        describe('when an existing showtime starts before the new range but overlaps', () => {
            let initialShowtime: ShowtimeDto

            beforeEach(async () => {
                // 기존 09:00–11:00 (120분), 새 요청은 10:00 부터라 startTime 만 보면 범위 밖.
                // endTime 이 새 범위와 겹치므로 overlap 으로 간주되어야 한다.
                const [created] = await createShowtimes(fix, [
                    {
                        endTime: new Date('2013-01-31T11:00'),
                        startTime: new Date('2013-01-31T09:00'),
                        theaterId: theater.id
                    }
                ])
                initialShowtime = created
            })

            // 충돌로 보고한다
            it('reports the conflict', async () => {
                const completionPromise = waitForCompletion(fix, 'failed')

                await fix.httpClient
                    .post('/showtime-creation/showtimes')
                    .body({
                        durationInMinutes: 120,
                        movieId: movie.id,
                        startTimes: [new Date('2013-01-31T10:00')],
                        theaterIds: [theater.id]
                    })
                    .accepted()

                await expect(completionPromise).resolves.toEqual({
                    conflictingShowtimes: [initialShowtime],
                    sagaId: expect.any(String),
                    status: 'failed'
                })
            })
        })
    })
})
