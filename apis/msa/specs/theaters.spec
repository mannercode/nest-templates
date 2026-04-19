#!/bin/bash
. ./_common.fixture

TEST "Create a theater" \
	201 POST /theaters \
	-H 'Content-Type: application/json' \
	-d '{
			"name": "theater name",
			"location": { "latitude": 37.5665, "longitude": 126.9780 },
			"seatmap": {
				"blocks": [
					{ "name": "A", "rows": [{ "name": "1", "layout": "OOOOOOOO" }] }
				]
			}
		}'

THEATER_ID=$(echo "${BODY}" | jq -r '.id')

TEST "Retrieve theaters page" \
	200 GET /theaters

TEST "Retrieve theater by ID" \
	200 GET /theaters/${THEATER_ID}

TEST "Update theater by ID" \
	200 PATCH /theaters/${THEATER_ID} \
	-H 'Content-Type: application/json' \
	-d '{ "name": "theater name updated" }'

TEST "Delete theater by ID" \
	204 DELETE /theaters/${THEATER_ID}
