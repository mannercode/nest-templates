#!/bin/bash
. ./_common.fixture

create_movie
publish_movie
create_theater

SHOWTIME_START_TIME=$(date -u -d '+1 day' '+%Y-%m-%dT%H:%M:%S.000Z')

TEST "Retrieve showtime-creation movies page" \
	200 GET /showtime-creation/movies

TEST "Retrieve showtime-creation theaters page" \
	200 GET /showtime-creation/theaters

TEST "Request showtime creation" \
	202 POST /showtime-creation/showtimes \
	-H 'Content-Type: application/json' \
	-d '{
			"movieId": "'${MOVIE_ID}'",
			"theaterIds": ["'${THEATER_ID}'"],
			"durationInMinutes": 120,
			"startTimes": ["'${SHOWTIME_START_TIME}'"]
		}'

wait_for_showtime

TEST "Search showtimes by theater IDs" \
	200 POST /showtime-creation/showtimes/search \
	-H 'Content-Type: application/json' \
	-d '{ "theaterIds": ["'${THEATER_ID}'"] }'
