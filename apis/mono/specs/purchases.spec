#!/bin/bash
. ./_common.fixture

create_and_login_customer
setup_showtime_resources
wait_for_tickets

SETUP POST /booking/showtimes/${SHOWTIME_ID}/tickets/hold \
	-H "Authorization: Bearer ${CUSTOMER_ACCESS_TOKEN}" \
	-H 'Content-Type: application/json' \
	-d '{ "ticketIds": ["'${TICKET_ID_1}'", "'${TICKET_ID_2}'"] }'

TEST "Create a purchase" \
	201 POST /purchases \
	-H 'Content-Type: application/json' \
	-d '{
			"customerId": "'${CUSTOMER_ID}'",
			"totalPrice": 20000,
			"purchaseItems": [
				{ "type": "tickets", "itemId": "'${TICKET_ID_1}'" },
				{ "type": "tickets", "itemId": "'${TICKET_ID_2}'" }
			]
		}'

PURCHASE_ID=$(echo "${BODY}" | jq -r '.id')

TEST "Retrieve purchase by ID" \
	200 GET /purchases/${PURCHASE_ID}
