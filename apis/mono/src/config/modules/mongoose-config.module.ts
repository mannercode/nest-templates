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
                    autoCreate: true,
                    autoIndex: true,
                    bufferCommands: true,
                    dbName: database,
                    // Pool size swept from (50, 200) down through (5, 20) —
                    // see docs/perf/cycle-04-pool-sizing.md. (10, 50) retained
                    // full read/write throughput at c=100/200/400 while
                    // quartering the connection count against the 3-node RS;
                    // dropping further to (5, 20) started queueing at c=200
                    // (−42% RPS on reads). 50 per app × 4 replicas = 200 total
                    // connections to the cluster, still well above the ~128
                    // concurrent ops we actually run per app at c=400.
                    minPoolSize: 10,
                    maxPoolSize: 50,
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
