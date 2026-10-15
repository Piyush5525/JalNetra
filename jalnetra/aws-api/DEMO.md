# Conduct Demo backend (exercise alerts)

Backend-only support for: Home → Conduct Demo → five exercise alerts → review → approve and call the
**demo phone** → public demo feed. Everything is isolated in `jn_demo_*` tables. Real incidents, contacts,
alerts and the existing `POST /incidents/{id}/alerts` flow are untouched.

Status: implemented, unit-tested locally, and reachable on the deployed API. An unauthenticated smoke check
confirmed the public route is active and returns a safe `404 NOT_FOUND` for an unknown session. No authenticated
session/approval smoke test has been run from this workspace, and no call has ever been placed.

## Endpoints

| Method and path | Auth | Purpose |
|---|---|---|
| `POST /demo/sessions` | operator key | Create (or re-read, if `requestId` repeats) a session with exactly 5 alerts. Never calls. |
| `GET /demo/sessions/{sessionId}` | operator key, creator only | Session, alerts, approval and call state, allowance. |
| `POST /demo/sessions/{sessionId}/alerts/{alertId}/approve` | operator key, creator only | Approve and, if allowed, reserve and dispatch **one** call to the demo phone. |
| `GET /demo/public/{sessionId}` | none | Read-only feed of approved exercise alerts. |

Bodies: create `{ "requestId": uuid }`. Approve `{ "requestId": uuid, "forecastHorizonHours": 0|3|6|12|24, "predictionDigest"?: 64-hex }`.
Any other field (phone, contact ids, channel, message, demo...) is rejected with `400 FIELD_NOT_ALLOWED`.
Errors: `{ "error": string, "code": string, "details"?: object }`. Codes: `UNAUTHENTICATED` 401, `FORBIDDEN_ROLE` 403,
`NOT_FOUND` 404 (also for another operator's session), `INVALID_BODY` / `FIELD_NOT_ALLOWED` / `UNSUPPORTED_HORIZON` 400,
`ALREADY_APPROVED` 409, `COOLDOWN` / `ALLOWANCE_EXHAUSTED` 429 (with `Retry-After`), `INTERNAL` 500.

## Behaviour that matters

- Messages are generated on the server (`demoScenarios.ts`) and always begin with the exercise notice.
- Destination is always the server-side `ALERT_PHONE`, through OmniDimension only. If the phone or OmniDimension is not
  configured the alert is approved with `callStatus: "not_configured"`, no attempt is made and no allowance is used.
- Approve order: (1) prior approval → return stored outcome (`replayed: true`) or `409 ALREADY_APPROVED` if the horizon or
  digest differs; (2) limits (session 3 calls, operator 10 per rolling 24 h, 30 s operator cooldown) → `429`, nothing written;
  (3) one transaction under a per-operator row lock writes approval, frozen prediction reference, call reservation
  (`dispatching`, attempts 1) and the ledger row; (4) only then the provider is contacted (10 s timeout).
- Outcomes: provider accepted → `dispatched` (not "answered"); 4xx or `success:false` → `failed`; timeout, network error or
  5xx → `unknown`. A call left in `dispatching` for over 60 s reads as `unknown`.
- One attempt per alert, ever. `UNIQUE (alert_id)` on the ledger enforces it in the database. No retries, automatic or manual.
- The public feed exposes only approved alerts: ids, title, messages, prediction reference, approval time and
  `demoCall: dispatched | not_confirmed`. No phone, owner, request ids, provider refs, errors or transcripts.
  Session ids are random UUIDv4, the response is `no-store` / `noindex`.
- The backend stores references only (scenario, village id, coordinates, simulated clock, model version, horizon, optional
  digest). It stores no flood geometry, risk scores or routes.

## Migration

The migration is the `-- ===== Conduct Demo` section at the end of `schema.sql`: four `CREATE TABLE IF NOT EXISTS`
(`jn_demo_operators`, `jn_demo_sessions`, `jn_demo_alerts`, `jn_demo_call_ledger`) and two indexes. It is idempotent and
touches no existing table. Run it through the existing migration Lambda, which executes the whole of `schema.sql`:
re-running the earlier parts is a no-op because every statement is `IF NOT EXISTS`. The live public-route check now
returns `404 NOT_FOUND` for an unknown UUID rather than `500 INTERNAL`, which confirms the deployed API can reach the
demo route and its storage path. The API does **not** create tables at runtime; if a fresh environment is used, run
the migration before the new Lambda code. Existing real-incident routes remain unaffected.

## Configuration

No new settings. Uses the existing `OMNIDIM_KEY`, `OMNIDIM_AGENT`, `OMNIDIM_FROM`, `ALERT_PHONE` from Secrets Manager.
Limits are constants at the top of `src/demo.ts`.

## Rollback

1. Redeploy the previous Lambda code (the old code ignores `/demo/*`).
2. Optionally drop the tables (nothing else references them):
   `DROP TABLE IF EXISTS jn_demo_call_ledger, jn_demo_alerts, jn_demo_sessions, jn_demo_operators;`
   Dropping erases the exercise record, including which calls were reserved.

## Tests

`npm test` (in `aws-api/`) compiles to `.test-build/` and runs `node --test`. The demo tests run the real migration SQL on
`pg-mem` with a mocked provider and clock. `pg-mem` ignores row locks, so the harness serialises transactions to stand in for
`SELECT ... FOR UPDATE`; the lock itself is not exercised, only the logic and the database backstops.

## Limitations

- Real Postgres row-lock behaviour, the 10 s timeout against the live provider and the end-to-end call are unverified.
- `dispatched` only means OmniDimension accepted the request.
- The prediction digest is supplied by the client and stored as-is. The server cannot verify it.
- No cleanup job: old sessions stay until dropped.


## Public exercise mode (no operator key)

`JALNETRA_PUBLIC_DEMO=true` on the API Lambda lets the `/demo/*` exercise routes run without an `x-jalnetra-key`. Those requests
are attributed to one shared `public-demo` principal, so the existing limits act as a single global cap: 3 calls per session,
a 30 s cooldown and 10 calls per 24 hours. No route accepts a phone number; a call can only go to the server-configured demo
phone (`ALERT_PHONE`). Incidents, contacts and alerts still require a key. To turn it off, remove the variable (or set it to
anything other than `true`); operator keys then work exactly as before.
