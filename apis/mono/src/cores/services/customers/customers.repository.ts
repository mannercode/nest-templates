import {
    QueryBuilderOptions,
    assignIfDefined,
    CrudRepository,
    QueryBuilder,
    leanToPublic
} from '@mannercode/common'
import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { MongooseConfigModule } from 'config'
import { Model } from 'mongoose'
import { CreateCustomerDto, SearchCustomersPageDto, UpdateCustomerDto } from './dtos'
import { Customer } from './models'

@Injectable()
export class CustomersRepository extends CrudRepository<Customer> {
    constructor(
        @InjectModel(Customer.name, MongooseConfigModule.connectionName)
        readonly model: Model<Customer>
    ) {
        super(model, MongooseConfigModule.maxTake)
    }

    async create(createDto: CreateCustomerDto) {
        const customer = this.newDocument()
        customer.name = createDto.name
        customer.email = createDto.email
        customer.birthDate = createDto.birthDate
        customer.password = createDto.password

        await customer.save()

        return customer.toJSON()
    }

    async existsByEmail(email: string): Promise<boolean> {
        const result = await this.model.exists({ email: { $eq: email } }).lean()

        // Explicitly converts a value to a boolean
        // 값을 boolean 타입으로 강제 변환
        return !!result
    }

    async findByEmailWithPassword(email: string) {
        // cycle-19: lean-virtuals 플러그인 제거 + leanToPublic (cycle-06 패턴).
        // login 경로라 customer.id 가 후속 auth 처리에서 쓰임 — 보존.
        const customer = await this.model
            .findOne({ email: { $eq: email } })
            .select('+password')
            .lean()
            .exec()

        return customer ? (leanToPublic(customer as any) as typeof customer) : null
    }

    async searchPage(searchDto: SearchCustomersPageDto) {
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

    async update(customerId: string, updateDto: UpdateCustomerDto) {
        const customer = await this.getDocumentById(customerId)

        assignIfDefined(customer, updateDto, 'name')
        assignIfDefined(customer, updateDto, 'email')
        assignIfDefined(customer, updateDto, 'birthDate')

        await customer.save()

        return customer.toJSON()
    }

    private buildQuery(searchDto: SearchCustomersPageDto, options: QueryBuilderOptions) {
        const { email, name } = searchDto

        const builder = new QueryBuilder<Customer>()
        // substring + case-insensitive 유지 (cycle-31 원복).
        builder.addRegex('name', name)
        builder.addRegex('email', email)

        const query = builder.build(options)
        return query
    }
}
