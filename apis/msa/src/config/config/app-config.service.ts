import { BaseConfigService } from '@mannercode/common'
import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Joi from 'joi'

@Injectable()
export class AppConfigService extends BaseConfigService {
    static schema = Joi.object({
        AUTH_ACCESS_SECRET: Joi.string().required(),

        AUTH_ACCESS_TOKEN_EXPIRATION: Joi.string().required(),
        AUTH_REFRESH_SECRET: Joi.string().required(),
        AUTH_REFRESH_TOKEN_EXPIRATION: Joi.string().required(),
        HTTP_PAGINATION_DEFAULT_SIZE: Joi.number().required(),

        HTTP_PORT: Joi.number().required(),
        HTTP_REQUEST_PAYLOAD_LIMIT: Joi.string().required(),
        LOG_CONSOLE_LEVEL: Joi.string().required(),
        LOG_DAYS_TO_KEEP: Joi.string().required(),
        LOG_DIRECTORY: Joi.string().required(),
        LOG_FILE_LEVEL: Joi.string().required(),
        MONGO_DATABASE: Joi.string().required(),
        MONGO_HOST1: Joi.string().required(),
        MONGO_HOST2: Joi.string().required(),
        MONGO_HOST3: Joi.string().required(),
        MONGO_PASSWORD: Joi.string().required(),
        MONGO_PORT1: Joi.number().required(),

        MONGO_PORT2: Joi.number().required(),
        MONGO_PORT3: Joi.number().required(),
        MONGO_REPLICA_SET: Joi.string().required(),
        MONGO_USERNAME: Joi.string().required(),
        NATS_HOST1: Joi.string().required(),
        NATS_HOST2: Joi.string().required(),
        NATS_HOST3: Joi.string().required(),
        NATS_PORT1: Joi.number().required(),
        NATS_PORT2: Joi.number().required(),
        NATS_PORT3: Joi.number().required(),

        NODE_ENV: Joi.string().valid('development', 'production', 'test').required(),
        REDIS_HOST1: Joi.string().required(),
        REDIS_HOST2: Joi.string().required(),
        REDIS_HOST3: Joi.string().required(),

        REDIS_PORT1: Joi.number().required(),
        REDIS_PORT2: Joi.number().required(),
        REDIS_PORT3: Joi.number().required(),

        S3_ACCESS_KEY: Joi.string().required(),
        S3_BUCKET: Joi.string().required(),
        S3_ENDPOINT: Joi.string().required(),
        S3_FORCE_PATH_STYLE: Joi.boolean().required(),
        S3_REGION: Joi.string().required(),
        S3_SECRET_KEY: Joi.string().required(),

        TEMPORAL_HOST: Joi.string().required(),
        TEMPORAL_NAMESPACE: Joi.string().default('default'),
        TEMPORAL_PORT: Joi.number().required()
    })

    get auth() {
        return {
            accessSecret: this.getString('AUTH_ACCESS_SECRET'),
            accessTokenExpiration: this.getString('AUTH_ACCESS_TOKEN_EXPIRATION'),
            refreshSecret: this.getString('AUTH_REFRESH_SECRET'),
            refreshTokenExpiration: this.getString('AUTH_REFRESH_TOKEN_EXPIRATION')
        }
    }

    get http() {
        return {
            paginationDefaultSize: this.getNumber('HTTP_PAGINATION_DEFAULT_SIZE'),
            port: this.getNumber('HTTP_PORT'),
            requestPayloadLimit: this.getString('HTTP_REQUEST_PAYLOAD_LIMIT')
        }
    }

    get log() {
        return {
            consoleLogLevel: this.getString('LOG_CONSOLE_LEVEL'),
            daysToKeepLogs: this.getString('LOG_DAYS_TO_KEEP'),
            directory: this.getString('LOG_DIRECTORY'),
            fileLogLevel: this.getString('LOG_FILE_LEVEL')
        }
    }

    get mongo() {
        return {
            database: this.getString('MONGO_DATABASE'),
            host1: `${this.getString('MONGO_HOST1')}:${this.getNumber('MONGO_PORT1')}`,
            host2: `${this.getString('MONGO_HOST2')}:${this.getNumber('MONGO_PORT2')}`,
            host3: `${this.getString('MONGO_HOST3')}:${this.getNumber('MONGO_PORT3')}`,
            password: this.getString('MONGO_PASSWORD'),
            replicaSet: this.getString('MONGO_REPLICA_SET'),
            user: this.getString('MONGO_USERNAME')
        }
    }

    get nats() {
        const servers = [
            `nats://${this.getString('NATS_HOST1')}:${this.getNumber('NATS_PORT1')}`,
            `nats://${this.getString('NATS_HOST2')}:${this.getNumber('NATS_PORT2')}`,
            `nats://${this.getString('NATS_HOST3')}:${this.getNumber('NATS_PORT3')}`
        ]

        return { servers }
    }

    get redis() {
        const nodes = [
            { host: this.getString('REDIS_HOST1'), port: this.getNumber('REDIS_PORT1') },
            { host: this.getString('REDIS_HOST2'), port: this.getNumber('REDIS_PORT2') },
            { host: this.getString('REDIS_HOST3'), port: this.getNumber('REDIS_PORT3') }
        ]

        return { nodes }
    }

    get temporal() {
        return {
            address: `${this.getString('TEMPORAL_HOST')}:${this.getNumber('TEMPORAL_PORT')}`,
            namespace: this.getString('TEMPORAL_NAMESPACE')
        }
    }

    get s3() {
        return {
            bucket: this.getString('S3_BUCKET'),
            credentials: {
                accessKeyId: this.getString('S3_ACCESS_KEY'),
                secretAccessKey: this.getString('S3_SECRET_KEY')
            },
            endpoint: this.getString('S3_ENDPOINT'),
            forcePathStyle: this.getBoolean('S3_FORCE_PATH_STYLE'),
            region: this.getString('S3_REGION')
        }
    }

    constructor(configService: ConfigService) {
        super(configService)
    }
}
