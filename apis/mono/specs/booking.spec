#!/bin/bash
. ./_common.fixture

create_and_login_customer
setup_showtime_resources

TEST "Search booking theaters by movie and location" \
	200 GET "/booking/movies/${MOVIE_ID}/theaters?latLong=37.5665,126.9780"

TEST "Search booking showdates by movie and theater" \
	200 GET /booking/movies/${MOVIE_ID}/theaters/${THEATER_ID}/showdates

SHOWDATE=$(echo "${BODY}" | jq -r '.[0] | split("T")[0] | gsub("-"; "")')

TEST "Search booking showtimes by movie, theater, and showdate" \
	200 GET /booking/movies/${MOVIE_ID}/theaters/${THEATER_ID}/showdates/${SHOWDATE}/showtimes

SHOWTIME_ID=$(echo "${BODY}" | jq -r '.[0].id')

wait_for_tickets

TEST "Retrieve booking tickets by showtime" \
	200 GET /booking/showtimes/${SHOWTIME_ID}/tickets

TICKET_ID_1=$(echo "${BODY}" | jq -r '.[0].id')
TICKET_ID_2=$(echo "${BODY}" | jq -r '.[1].id')

TEST "Hold booking tickets for a customer" \
	200 POST /booking/showtimes/${SHOWTIME_ID}/tickets/hold \
	-H "Authorization: Bearer ${CUSTOMER_ACCESS_TOKEN}" \
	-H 'Content-Type: application/json' \
	-d '{ "ticketIds": ["'${TICKET_ID_1}'", "'${TICKET_ID_2}'"] }'
