import type { CustomerDto, SearchCustomersPageDto } from 'cores'
import { omit } from '@mannercode/common'
import { nullObjectId } from '@mannercode/testing'
import type { CustomersFixture } from './customers.fixture'
import { buildCreateCustomerDto, createCustomer, Errors } from '../__helpers__'

describe('CustomersService', () => {
    let fix: CustomersFixture

    beforeEach(async () => {
        const { createCustomersFixture } = await import('./customers.fixture')
        fix = await createCustomersFixture()
    })
    afterEach(() => fix.teardown())

    describe('POST /customers', () => {
        // 생성된 고객을 반환한다
        it('returns the created customer', async () => {
            const createDto = buildCreateCustomerDto()

            await fix.httpClient
                .post('/customers')
                .body(createDto)
                .created({ ...omit(createDto, ['password']), id: expect.any(String) })
        })

        // 이메일이 이미 존재할 때
        describe('when the email already exists', () => {
            const email = 'user@mail.com'

            beforeEach(async () => {
                await createCustomer(fix, { email })
            })

            // 409 Conflict를 반환한다
            it('returns 409 Conflict', async () => {
                const createDto = buildCreateCustomerDto({ email })

                await fix.httpClient
                    .post('/customers')
                    .body(createDto)
                    .conflict(Errors.Customers.EmailAlreadyExists(createDto.email))
            })
        })

        // 같은 이메일로 동시에 여러 요청이 들어올 때
        describe('when multiple requests create with the same email concurrently', () => {
            // 정확히 하나는 201 Created, 나머지는 전부 409 Conflict 여야 한다 (500 노출 금지)
            it(
                'accepts exactly one request and rejects others with 409 only',
                async () => {
                    const email = 'race@mail.com'
                    const count = 10
                    const { HttpTestClient } = await import('@mannercode/testing')
                    const serverUrl = fix.httpClient.serverUrl

                    const statuses = await Promise.all(
                        Array.from({ length: count }, async () => {
                            const client = new HttpTestClient(serverUrl)
                            const response = await client
                                .post('/customers')
                                .body(buildCreateCustomerDto({ email }))
                                .sendRaw()
                            return response.status
                        })
                    )

                    const createdCount = statuses.filter((s) => s === 201).length
                    const conflictCount = statuses.filter((s) => s === 409).length
                    const otherStatuses = statuses.filter((s) => s !== 201 && s !== 409)

                    expect(createdCount).toBe(1)
                    expect(conflictCount).toBe(count - 1)
                    expect(otherStatuses).toEqual([])
                },
                30 * 1000
            )
        })

        // 필수 필드가 누락되었을 때
        describe('when required fields are missing', () => {
            // 400 Bad Request를 반환한다
            it('returns 400 Bad Request', async () => {
                await fix.httpClient
                    .post('/customers')
                    .body({})
                    .badRequest(Errors.RequestValidation.Failed(expect.any(Array)))
            })
        })

        // 중복 키 이외의 저장 오류가 발생할 때
        describe('when the repository rejects with a non-duplicate error', () => {
            // 오류를 그대로 전파한다 (ConflictException 으로 변환하지 않는다)
            it('propagates the error', async () => {
                const { CustomersService } = await import('cores')
                const service = fix.module.get(CustomersService)

                // birthDate 를 유효하지 않은 형식으로 넣어 Mongoose CastError 유발.
                // 컨트롤러 레벨의 class-validator 를 우회하기 위해 service 를 직접 호출한다.
                const invalidDto = buildCreateCustomerDto({
                    birthDate: 'not-a-date' as unknown as Date
                })

                await expect(service.create(invalidDto)).rejects.toThrow()
            })
        })
    })

    describe('GET /customers/:id', () => {
        // 고객이 존재할 때
        describe('when the customer exists', () => {
            let customer: CustomerDto

            beforeEach(async () => {
                customer = await createCustomer(fix)
            })

            // 고객을 반환한다
            it('returns the customer', async () => {
                await fix.httpClient.get(`/customers/${customer.id}`).ok(customer)
            })
        })

        // 고객이 존재하지 않을 때
        describe('when the customer does not exist', () => {
            // 404 Not Found를 반환한다
            it('returns 404 Not Found', async () => {
                await fix.httpClient
                    .get(`/customers/${nullObjectId}`)
                    .notFound(Errors.Mongoose.MultipleDocumentsNotFound([nullObjectId]))
            })
        })
    })

    describe('PATCH /customers/:id', () => {
        // 고객이 존재할 때
        describe('when the customer exists', () => {
            let customer: CustomerDto

            beforeEach(async () => {
                customer = await createCustomer(fix, { name: 'original-name' })
            })

            // 수정된 고객을 반환한다
            it('returns the updated customer', async () => {
                const updateDto = { birthDate: new Date('1900-12-31'), email: 'new@mail.com' }

                await fix.httpClient
                    .patch(`/customers/${customer.id}`)
                    .body(updateDto)
                    .ok({ ...customer, ...updateDto })
            })

            // 수정 내용이 저장된다
            it('persists the update', async () => {
                const updateDto = { name: 'update-name' }
                await fix.httpClient.patch(`/customers/${customer.id}`).body(updateDto).ok()

                await fix.httpClient
                    .get(`/customers/${customer.id}`)
                    .ok({ ...customer, ...updateDto })
            })
        })

        // 고객이 존재하지 않을 때
        describe('when the customer does not exist', () => {
            // 404 Not Found를 반환한다
            it('returns 404 Not Found', async () => {
                await fix.httpClient
                    .patch(`/customers/${nullObjectId}`)
                    .body({})
                    .notFound(Errors.Mongoose.DocumentNotFound(nullObjectId))
            })
        })
    })

    describe('DELETE /customers/:id', () => {
        // 고객이 존재할 때
        describe('when the customer exists', () => {
            let customer: CustomerDto

            beforeEach(async () => {
                customer = await createCustomer(fix)
            })

            // 204 No Content를 반환한다
            it('returns 204 No Content', async () => {
                await fix.httpClient.delete(`/customers/${customer.id}`).noContent()
            })

            // 삭제가 저장된다
            it('persists the deletion', async () => {
                await fix.httpClient.delete(`/customers/${customer.id}`).noContent()

                await fix.httpClient
                    .get(`/customers/${customer.id}`)
                    .notFound(Errors.Mongoose.MultipleDocumentsNotFound([customer.id]))
            })
        })

        // 고객이 존재하지 않을 때
        describe('when the customer does not exist', () => {
            // 204 No Content를 반환한다
            it('returns 204 No Content', async () => {
                await fix.httpClient.delete(`/customers/${nullObjectId}`).noContent()
            })
        })
    })

    describe('GET /customers', () => {
        let customerA1: CustomerDto
        let customerA2: CustomerDto
        let customerB1: CustomerDto
        let customerB2: CustomerDto

        beforeEach(async () => {
            const createdCustomers = await Promise.all([
                createCustomer(fix, { email: 'user-a1@mail.com', name: 'customer-a1' }),
                createCustomer(fix, { email: 'user-a2@mail.com', name: 'customer-a2' }),
                createCustomer(fix, { email: 'user-b1@mail.com', name: 'customer-b1' }),
                createCustomer(fix, { email: 'user-b2@mail.com', name: 'customer-b2' })
            ])
            customerA1 = createdCustomers[0]
            customerA2 = createdCustomers[1]
            customerB1 = createdCustomers[2]
            customerB2 = createdCustomers[3]
        })

        const buildExpectedPage = (customers: CustomerDto[]) => ({
            items: expect.arrayContaining(customers),
            page: 1,
            size: expect.any(Number),
            total: customers.length
        })

        // 쿼리가 제공되지 않을 때
        describe('when the query is not provided', () => {
            // 기본 고객 페이지를 반환한다
            it('returns the default page of customers', async () => {
                const expected = buildExpectedPage([customerA1, customerA2, customerB1, customerB2])

                await fix.httpClient.get('/customers').ok(expected)
            })
        })

        // 필터가 제공될 때
        describe('when the filter is provided', () => {
            const queryAndExpect = (query: SearchCustomersPageDto, customers: CustomerDto[]) =>
                fix.httpClient.get('/customers').query(query).ok(buildExpectedPage(customers))

            // 부분 이름 일치로 필터링된 고객을 반환한다
            it('returns customers filtered by a partial name match', async () => {
                await queryAndExpect({ name: 'customer-a' }, [customerA1, customerA2])
            })

            // 부분 이메일 일치로 필터링된 고객을 반환한다
            it('returns customers filtered by a partial email match', async () => {
                await queryAndExpect({ email: 'user-b' }, [customerB1, customerB2])
            })
        })

        // 쿼리 파라미터가 유효하지 않을 때
        describe('when the query parameters are invalid', () => {
            // 400 Bad Request를 반환한다
            it('returns 400 Bad Request', async () => {
                await fix.httpClient
                    .get('/customers')
                    .query({ wrong: 'value' })
                    .badRequest(Errors.RequestValidation.Failed(expect.any(Array)))
            })
        })
    })

    describe('CustomersRepository.existsByEmail', () => {
        const email = 'exists-check@mail.com'

        // 같은 이메일의 고객이 존재할 때
        describe('when a customer with the email exists', () => {
            beforeEach(async () => {
                await createCustomer(fix, { email })
            })

            // true를 반환한다
            it('returns true', async () => {
                const { CustomersRepository } = await import('cores')
                const repo = fix.module.get(CustomersRepository)

                await expect(repo.existsByEmail(email)).resolves.toBe(true)
            })
        })

        // 같은 이메일의 고객이 없을 때
        describe('when no customer with the email exists', () => {
            // false를 반환한다
            it('returns false', async () => {
                const { CustomersRepository } = await import('cores')
                const repo = fix.module.get(CustomersRepository)

                await expect(repo.existsByEmail('does-not-exist@mail.com')).resolves.toBe(false)
            })
        })
    })
})
