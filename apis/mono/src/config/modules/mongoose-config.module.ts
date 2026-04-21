import { Module } from '@nestjs/common'
import { getConnectionToken, MongooseModule } from '@nestjs/mongoose'
import { SchemaOptions } from 'mongoose'
import { AppConfigService } from '../config'

@Module({
    imports: [
        MongooseModule.forRootAsync({
            connectionName: MongooseConfigModule.connectionName,
            inject: [AppConfigService],
            useFactory: async (config: AppConfigService) => {
                const { database, host1, host2, host3, password, replicaSet, user } = config.mongo

                return {
                    autoCreate: false,
                    autoIndex: false,
                    bufferCommands: true,
                    dbName: database,
                    maxPoolSize: 200,
                    uri: `mongodb://${user}:${password}@${host1},${host2},${host3}/?replicaSet=${replicaSet}`,
                    waitQueueTimeoutMS: 5000,
                    writeConcern: { journal: true, w: 'majority', wtimeoutMS: 5000 }
                }
            }
        })
    ]
})
export class MongooseConfigModule {
    static schemaOptions: SchemaOptions = {
        minimize: false,
        // https://mongoosejs.com/docs/guide.html#optimisticConcurrency
        optimisticConcurrency: true,
        strict: 'throw',
        strictQuery: 'throw',
        timestamps: true,
        toJSON: { flattenObjectIds: true, versionKey: false, virtuals: true },
        validateBeforeSave: true
    }

    static get connectionName() {
        return 'mongo-connection'
    }

    static get maxTake() {
        return 50
    }

    static get moduleName() {
        return getConnectionToken(this.connectionName)
    }
}
