#!/bin/bash
. ./_common.fixture

CUSTOMER_EMAIL=$(random_email)

TEST "Create a customer" \
	201 POST /customers \
	-H 'Content-Type: application/json' \
	-d '{
			"name": "customer name",
			"birthDate": "1990-01-01T00:00:00.000Z",
			"email": "'${CUSTOMER_EMAIL}'",
			"password": "password"
		}'

CUSTOMER_ID=$(echo "${BODY}" | jq -r '.id')

TEST "Login customer" \
	200 POST /customers/login \
	-H 'Content-Type: application/json' \
	-d '{ "email": "'${CUSTOMER_EMAIL}'", "password": "password" }'

CUSTOMER_ACCESS_TOKEN=$(echo "${BODY}" | jq -r '.accessToken')
CUSTOMER_REFRESH_TOKEN=$(echo "${BODY}" | jq -r '.refreshToken')

TEST "Refresh customer tokens" \
	200 POST /customers/refresh \
	-H 'Content-Type: application/json' \
	-d '{ "refreshToken": "'${CUSTOMER_REFRESH_TOKEN}'" }'

CUSTOMER_ACCESS_TOKEN=$(echo "${BODY}" | jq -r '.accessToken')
CUSTOMER_REFRESH_TOKEN=$(echo "${BODY}" | jq -r '.refreshToken')

TEST "Retrieve current customer" \
	200 GET /customers/me \
	-H "Authorization: Bearer ${CUSTOMER_ACCESS_TOKEN}"

TEST "Retrieve customers page" \
	200 GET /customers \
	-H "Authorization: Bearer ${CUSTOMER_ACCESS_TOKEN}"

TEST "Retrieve customer by ID" \
	200 GET /customers/${CUSTOMER_ID} \
	-H "Authorization: Bearer ${CUSTOMER_ACCESS_TOKEN}"

TEST "Update customer by ID" \
	200 PATCH /customers/${CUSTOMER_ID} \
	-H "Authorization: Bearer ${CUSTOMER_ACCESS_TOKEN}" \
	-H "Content-Type: application/json" \
	-d '{ "name": "new name", "birthDate": "2000-01-01T00:00:00.000Z" }'

TEST "Delete customer by ID" \
	204 DELETE /customers/${CUSTOMER_ID} \
	-H "Authorization: Bearer ${CUSTOMER_ACCESS_TOKEN}"
