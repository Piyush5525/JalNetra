#!/usr/bin/env bash
# JalNetra Conduct Demo: NO-PROVIDER smoke test (curl + jq).
#
#   BASE_URL=https://u51iah4nqf.execute-api.ap-south-1.amazonaws.com \
#   JN_KEY=<operator key>  [JN_KEY2=<second operator key>]  ./demo-smoke.sh
#
# Keys are read from the environment only. They are never printed, never written to disk
# and never passed on the command line (curl reads headers from a private temp file).
#
# SAFETY: this script can only reach an approve request if BOTH gates show the demo phone is NOT configured:
#   gate 1: GET /telephony        -> demo_phone must be null
#   gate 2: POST /demo/sessions   -> demoDestination.configured must be false
# Otherwise it aborts before any approve. With the phone unset an approve returns not_configured
# and no provider request is made. It never calls OmniDimension on purpose.
set -u

BASE_URL="${BASE_URL:-}"
JN_KEY="${JN_KEY:-}"
JN_KEY2="${JN_KEY2:-}"
[ -n "$BASE_URL" ] || { echo "Set BASE_URL (no trailing slash)"; exit 2; }
[ -n "$JN_KEY" ] || { echo "Set JN_KEY (operator key)"; exit 2; }
command -v curl >/dev/null || { echo "curl is required"; exit 2; }
command -v jq >/dev/null || { echo "jq is required"; exit 2; }
BASE_URL="${BASE_URL%/}"

WORK="$(mktemp -d)"; chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
umask 077
FAILS=0
REQ_IDS=()

newid() { local g; g="$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen | tr 'A-Z' 'a-z')"; REQ_IDS+=("$g"); echo "$g"; }

# call METHOD PATH [JSON_BODY] [KEY]  -> sets STATUS, BODY_FILE, HDR_FILE
call() {
  local method="$1" path="$2" body="${3:-}" key="${4:-}"
  BODY_FILE="$WORK/body.json"; HDR_FILE="$WORK/headers.txt"; : > "$BODY_FILE"; : > "$HDR_FILE"
  local cfg="$WORK/curl.cfg"; : > "$cfg"
  { echo "silent"; echo "max-time = 20"; case "$BASE_URL" in http://127.0.0.1*|http://localhost*) echo 'noproxy = "*"';; esac; echo "request = \"$method\""; echo "url = \"$BASE_URL$path\""
    echo "dump-header = \"$HDR_FILE\""; echo "output = \"$BODY_FILE\""
    [ -n "$key" ] && echo "header = \"x-jalnetra-key: $key\""
    if [ -n "$body" ]; then echo "header = \"content-type: application/json\""; printf '%s' "$body" > "$WORK/req.json"; echo "data-binary = \"@$WORK/req.json\""; fi
  } >> "$cfg"
  STATUS="$(curl -K "$cfg" -w '%{http_code}')"
  rm -f "$cfg" "$WORK/req.json"
}
j() { jq -r "$1" "$BODY_FILE" 2>/dev/null; }

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1  ${2:-}"; FAILS=$((FAILS + 1)); }
check() { # check NAME CONDITION_EXIT_CODE [DETAIL]
  if [ "$2" -eq 0 ]; then pass "$1"; else fail "$1" "${3:-} (status $STATUS)"; fi
}
expect_status() { [ "$STATUS" = "$2" ]; check "$1" $? "expected $2"; }
abort() { echo "ABORT: $1"; echo "requestIds used: ${REQ_IDS[*]:-none}"; exit 3; }

echo "== Gates (read-only) =="
call GET /health
[ "$STATUS" = "200" ] || abort "API health check failed (status $STATUS)"
call GET /telephony "" "$JN_KEY"
[ "$STATUS" = "200" ] || abort "GET /telephony failed (status $STATUS): operator key rejected?"
if [ "$(j '.demo_phone')" != "null" ]; then abort "demo phone is configured on the server (/telephony). An approve could place a real call. Remove ALERT_PHONE and use fresh containers first."; fi
pass "gate 1: /telephony reports no demo phone"

echo "== Auth =="
call POST /demo/sessions "{\"requestId\":\"$(newid)\"}"
expect_status "a1 no key -> 401" 401
[ "$(j '.code')" = "UNAUTHENTICATED" ]; check "a1 code UNAUTHENTICATED" $?
call POST /demo/sessions "{\"requestId\":\"$(newid)\"}" "not-a-real-key"
expect_status "a2 wrong key -> 401" 401
call GET /demo/sessions/00000000-0000-4000-8000-000000000000
expect_status "a3 session read without key -> 401" 401

echo "== Session creation =="
RID="$(newid)"
call POST /demo/sessions "{\"requestId\":\"$RID\"}" "$JN_KEY"
expect_status "b create session -> 201" 201
[ "$STATUS" = "201" ] || abort "cannot continue (500 here usually means the migration has not created the demo tables)"
SESSION="$(j '.id')"; A1="$(j '.alerts[0].id')"; A2="$(j '.alerts[1].id')"
[ "$(j '.alerts | length')" = "5" ]; check "b exactly 5 alerts" $?
[ "$(j '[.alerts[] | select(.approvalStatus!="pending" or .callStatus!="not_requested" or .callAttempts!=0)] | length')" = "0" ]; check "b all pending / not_requested / 0 attempts" $?
[ "$(j '.alerts[0].prediction.villageName')" = "Harpur" ]; check "b alert 1 is Harpur" $?
[ "$(j '.scenarioVersion')" = "gandak-exercise-v1" ]; check "b scenario version" $?
if [ "$(j '.demoDestination.configured')" != "false" ]; then abort "gate 2: API reports a configured demo phone. Not approving anything."; fi
pass "gate 2: session reports demoDestination.configured=false"

call POST /demo/sessions "{\"requestId\":\"$RID\"}" "$JN_KEY"
expect_status "c same requestId -> 200" 200
[ "$(j '.id')" = "$SESSION" ]; check "c same session id (idempotent)" $?

call GET "/demo/sessions/$SESSION" "" "$JN_KEY"
expect_status "c2 read own session -> 200" 200

echo "== Validation (nothing here can reach the provider) =="
AP="/demo/sessions/$SESSION/alerts/$A2/approve"
call POST "$AP" "{\"requestId\":\"$(newid)\",\"forecastHorizonHours\":6,\"phone\":\"+910000000000\"}" "$JN_KEY"
expect_status "g injected phone -> 400" 400
[ "$(j '.code')" = "FIELD_NOT_ALLOWED" ]; check "g code FIELD_NOT_ALLOWED" $?
call POST "$AP" "{\"requestId\":\"$(newid)\",\"forecastHorizonHours\":6,\"contact_ids\":[\"x\"]}" "$JN_KEY"
expect_status "g2 injected contact_ids -> 400" 400
call POST "$AP" "{\"requestId\":\"$(newid)\",\"forecastHorizonHours\":6,\"message\":\"custom\"}" "$JN_KEY"
expect_status "g3 injected message -> 400" 400
call POST "$AP" "{\"requestId\":\"$(newid)\",\"forecastHorizonHours\":5}" "$JN_KEY"
expect_status "h horizon 5 -> 400" 400
[ "$(j '.code')" = "UNSUPPORTED_HORIZON" ]; check "h code UNSUPPORTED_HORIZON" $?
call POST "$AP" "{\"requestId\":\"nope\",\"forecastHorizonHours\":6}" "$JN_KEY"
expect_status "h2 bad requestId -> 400" 400
call POST "/demo/sessions/$SESSION/alerts/00000000-0000-4000-8000-000000000000/approve" "{\"requestId\":\"$(newid)\",\"forecastHorizonHours\":6}" "$JN_KEY"
expect_status "h3 unknown alert -> 404" 404
call GET "/demo/sessions/$SESSION" "" "$JN_KEY"
[ "$(j '[.alerts[] | select(.approvalStatus!="pending")] | length')" = "0" ]; check "validation failures left every alert pending" $?

echo "== Approve alert 1 (phone unset -> not_configured, no provider request) =="
AP1="/demo/sessions/$SESSION/alerts/$A1/approve"
call POST "$AP1" "{\"requestId\":\"$(newid)\",\"forecastHorizonHours\":6}" "$JN_KEY"
expect_status "d approve -> 200" 200
[ "$(j '.replayed')" = "false" ]; check "d replayed=false" $?
[ "$(j '.alert.approvalStatus')" = "approved" ]; check "d approvalStatus approved" $?
[ "$(j '.alert.callStatus')" = "not_configured" ]; check "d callStatus not_configured" $?
[ "$(j '.alert.callAttempts')" = "0" ]; check "d callAttempts 0" $?
[ "$(j '.session.allowance.callsUsed')" = "0" ]; check "d allowance callsUsed 0" $?
[ "$(j '.alert.prediction.horizonHours')" = "6" ]; check "d horizon frozen at 6" $?
if [ "$(j '.alert.callStatus')" != "not_configured" ]; then abort "UNEXPECTED call status '$(j '.alert.callStatus')'. Stop and check CloudWatch for an OmniDimension request now."; fi

call POST "$AP1" "{\"requestId\":\"$(newid)\",\"forecastHorizonHours\":6}" "$JN_KEY"
expect_status "e repeat approve -> 200" 200
[ "$(j '.replayed')" = "true" ]; check "e replayed=true" $?
[ "$(j '.alert.callStatus')" = "not_configured" ]; check "e same stored outcome" $?
call POST "$AP1" "{\"requestId\":\"$(newid)\",\"forecastHorizonHours\":12}" "$JN_KEY"
expect_status "f different horizon -> 409" 409
[ "$(j '.code')" = "ALREADY_APPROVED" ]; check "f code ALREADY_APPROVED" $?
call POST "$AP1" "{\"requestId\":\"$(newid)\",\"forecastHorizonHours\":6,\"predictionDigest\":\"$(printf 'a%.0s' $(seq 1 64))\"}" "$JN_KEY"
expect_status "f2 digest added after approval -> 409" 409

echo "== Access control =="
if [ -n "$JN_KEY2" ]; then
  call GET "/demo/sessions/$SESSION" "" "$JN_KEY2"
  expect_status "i other operator read -> 404" 404
  call POST "$AP1" "{\"requestId\":\"$(newid)\",\"forecastHorizonHours\":6}" "$JN_KEY2"
  expect_status "i2 other operator approve -> 404" 404
else
  echo "SKIP  i other-operator checks (set JN_KEY2 to run them)"
fi

echo "== Public feed (anonymous) =="
call GET "/demo/public/$SESSION"
expect_status "j public feed -> 200" 200
[ "$(j '.exercise')" = "true" ]; check "j exercise=true" $?
[ "$(j '.items | length')" = "1" ]; check "j only the approved alert (1 item)" $?
[ "$(j '.items[0].prediction.horizonHours')" = "6" ]; check "j frozen horizon 6" $?
[ "$(j '.items[0].demoCall')" = "not_confirmed" ]; check "j demoCall not_confirmed" $?
grep -qi '^cache-control:.*no-store' "$HDR_FILE"; check "j Cache-Control: no-store" $?
LEAK=""
for term in approvedBy createdBy requestId callStatus callAttempts demoDestination allowance providerRef provider_ref transcript contact; do
  grep -qi "$term" "$BODY_FILE" && LEAK="$LEAK $term"
done
grep -Eq '\+[0-9]{8,}' "$BODY_FILE" && LEAK="$LEAK phone-number"
[ -z "$LEAK" ]; check "j no private fields in public body" $? "leaked:$LEAK"
call GET "/demo/public/00000000-0000-4000-8000-0000000000aa"
expect_status "k unknown public session -> 404" 404
call GET "/demo/public/not-a-uuid"
expect_status "k2 malformed public id -> 404" 404

echo "== Existing API unaffected =="
call GET "/incidents?limit=1" "" "$JN_KEY"
expect_status "l GET /incidents still works" 200
call GET /health
expect_status "l2 GET /health" 200

echo
echo "Session id : $SESSION"
echo "requestIds : ${REQ_IDS[*]}"
echo "Still to check manually: CloudWatch /aws/lambda/jalnetra-api shows NO OmniDimension request during this run."
if [ "$FAILS" -gt 0 ]; then echo "RESULT: $FAILS check(s) FAILED"; exit 1; fi
echo "RESULT: all checks passed. STOP here: restoring ALERT_PHONE and any real call need separate confirmation."
