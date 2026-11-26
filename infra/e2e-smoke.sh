#!/usr/bin/env bash
# Smoke test for the Docker images: brings up infra/compose.e2e.yml, waits for
# every service to be healthy, checks the health endpoints and that the OCPP
# gateway refuses a WebSocket upgrade without credentials, then tears the
# stack down (also on failure, after printing the logs).
#
#   infra/e2e-smoke.sh                 build the images, then test
#   E2E_NO_BUILD=1 infra/e2e-smoke.sh  use nd-api:e2e and nd-ocpp-gateway:e2e as built
#
# E2E_EXPECT_WS_STATUS pins the refusal to one status code (e.g. 401 once the
# gateway checks Basic Auth); by default any 4xx counts as refused.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
api="http://127.0.0.1:${E2E_API_PORT:-13000}"
gateway="http://127.0.0.1:${E2E_GATEWAY_PORT:-19000}"
stripe="http://127.0.0.1:${E2E_STRIPE_PORT:-12111}"

compose() {
  docker compose --file "$here/compose.e2e.yml" "$@"
}

teardown() {
  local status=$?
  if ((status != 0)); then
    echo "--- smoke test failed; service state and logs follow" >&2
    compose ps --all >&2 || true
    compose logs --no-color --tail 200 >&2 || true
  fi
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  exit "$status"
}
trap teardown EXIT

failures=0
pass() { printf 'ok    %s\n' "$*"; }
fail() {
  printf 'FAIL  %s\n' "$*" >&2
  failures=$((failures + 1))
}

# Expects HTTP status $1 from GET $2.
expect_status() {
  local want="$1" url="$2" got
  got="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 "$url" || true)"
  if [[ "$got" == "$want" ]]; then
    pass "GET $url -> $got"
  else
    fail "GET $url -> $got, expected $want"
  fi
}

build_flag=--build
if [[ "${E2E_NO_BUILD:-}" == 1 ]]; then
  build_flag=--no-build
fi

echo "starting the e2e stack"
compose up --detach "$build_flag" --wait --wait-timeout 300

expect_status 200 "$api/healthz"
expect_status 200 "$api/readyz"
expect_status 200 "$gateway/healthz"
expect_status 200 "$gateway/readyz"

# stripe-mock answers like the real API given any test key.
got="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 \
  --user sk_test_e2e: "$stripe/v1/customers" || true)"
if [[ "$got" == 200 ]]; then
  pass "stripe-mock GET /v1/customers -> $got"
else
  fail "stripe-mock GET /v1/customers -> $got, expected 200"
fi

# A charger's upgrade request, minus the Basic Auth header. It must never be
# switched to a WebSocket (101).
ws_status="$(curl --silent --http1.1 --output /dev/null --write-out '%{http_code}' --max-time 10 \
  --header 'Connection: Upgrade' \
  --header 'Upgrade: websocket' \
  --header 'Sec-WebSocket-Version: 13' \
  --header 'Sec-WebSocket-Key: c21va2UtdGVzdC1ub25jZQ==' \
  --header 'Sec-WebSocket-Protocol: ocpp1.6' \
  "$gateway/v16/SMOKE-TEST" || true)"
if [[ -n "${E2E_EXPECT_WS_STATUS:-}" ]]; then
  if [[ "$ws_status" == "$E2E_EXPECT_WS_STATUS" ]]; then
    pass "unauthenticated OCPP upgrade refused with $ws_status"
  else
    fail "unauthenticated OCPP upgrade got $ws_status, expected $E2E_EXPECT_WS_STATUS"
  fi
elif [[ "$ws_status" =~ ^4[0-9][0-9]$ ]]; then
  pass "unauthenticated OCPP upgrade refused with $ws_status"
else
  fail "unauthenticated OCPP upgrade got $ws_status, expected a 4xx refusal"
fi

if ((failures > 0)); then
  echo "$failures check(s) failed" >&2
  exit 1
fi
echo "all smoke checks passed"
