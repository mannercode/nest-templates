#!/bin/bash
. ./_common.fixture

TEST "Create a movie" \
	201 POST /movies \
	-H 'Content-Type: application/json' \
	-d '{
			"title": "movie title",
			"genres": ["action", "drama"],
			"releaseDate": "2024-01-01T00:00:00.000Z",
			"plot": "movie plot for e2e flow",
			"durationInSeconds": 7200,
			"director": "e2e director",
			"rating": "PG",
			"assetIds": []
		}'

MOVIE_ID=$(echo "${BODY}" | jq -r '.id')

TEST "Retrieve movies page" \
	200 GET /movies

TEST "Update movie by ID" \
	200 PATCH /movies/${MOVIE_ID} \
	-H 'Content-Type: application/json' \
	-d '{
			"plot": "updated movie plot",
			"director": "updated e2e director"
		}'

TEST "Publish movie by ID" \
	200 POST /movies/${MOVIE_ID}/publish

TEST "Create a movie asset" \
	201 POST /movies/${MOVIE_ID}/assets \
	-H 'Content-Type: application/json' \
	-d '{
			"originalName": "'${ASSET_IMAGE_ORIGINAL_NAME}'",
			"mimeType": "image/png",
			"size": '${ASSET_IMAGE_SIZE}',
			"checksum": {
				"algorithm": "sha256",
				"base64": "'${ASSET_IMAGE_SHA256_BASE64}'"
			}
		}'

ASSET_ID=$(echo "${BODY}" | jq -r '.assetId')

LOG_LINE "# Presigned post upload"
upload_presigned_post "${ASSET_IMAGE_PATH}" "${BODY}"
LOG_LINE ""

TEST "Complete movie asset after upload" \
	204 POST /movies/${MOVIE_ID}/assets/${ASSET_ID}/finalize

TEST "Retrieve movie by ID" \
	200 GET /movies/${MOVIE_ID}

TEST "Delete movie asset" \
	204 DELETE /movies/${MOVIE_ID}/assets/${ASSET_ID}

TEST "Delete movie by ID" \
	204 DELETE /movies/${MOVIE_ID}

TEST "Search recommended movies" \
	200 GET /movies/recommended
