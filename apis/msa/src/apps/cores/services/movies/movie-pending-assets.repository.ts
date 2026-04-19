import { CrudRepository, QueryBuilder } from '@mannercode/common'
import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { MongooseConfigModule } from 'config'
import { Model } from 'mongoose'
import { MoviePendingAsset } from './models'

@Injectable()
export class MoviePendingAssetsRepository extends CrudRepository<MoviePendingAsset> {
    constructor(
        @InjectModel(MoviePendingAsset.name, MongooseConfigModule.connectionName)
        readonly model: Model<MoviePendingAsset>
    ) {
        super(model, MongooseConfigModule.maxTake)
    }

    async addPendingAsset(movieId: string, assetId: string) {
        const pendingAsset = this.newDocument()
        pendingAsset.assetId = assetId
        pendingAsset.movieId = movieId
        await pendingAsset.save()

        return pendingAsset.toJSON()
    }

    async hasPendingAsset(movieId: string, assetId: string): Promise<boolean> {
        const builder = new QueryBuilder<MoviePendingAsset>()
        builder.addEquals('movieId', movieId)
        builder.addEquals('assetId', assetId)
        const query = builder.build({})

        const count = await this.model.countDocuments(query)
        return 0 < count
    }

    async removePendingAsset(movieId: string, assetId: string): Promise<void> {
        const builder = new QueryBuilder<MoviePendingAsset>()
        builder.addEquals('movieId', movieId)
        builder.addEquals('assetId', assetId)
        const query = builder.build({})

        await this.model.deleteOne(query).exec()
    }
}
