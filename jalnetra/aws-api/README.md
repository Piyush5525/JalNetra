# JalNetra AWS API

This directory is a self-contained Node.js/TypeScript Lambda HTTP API port of the Supabase Edge Function contract in `backbone/jalnetra-api/index.ts`. Deploy the compiled `dist/` directory and its production dependencies behind API Gateway HTTP API. The exported Lambda entry point is `dist/handler.handler`.

## Routes

The API keeps the existing routes and response contract:

- `GET /health` (no API key)
- `POST /incidents`, `GET /incidents`
- `GET /incidents/:id`, `PATCH /incidents/:id`
- `POST /incidents/:id/evidence`
- `GET /telephony`
- `GET /contacts`, `POST /contacts`
- `GET /incidents/:id/alerts`, `POST /incidents/:id/alerts`

All routes except `/health` and CORS preflight require `x-jalnetra-key`. API key values are hashed with SHA-256 before looking up `jn_api_keys`; the raw key is never stored by this package.

## Environment variables

Configure these in the Lambda deployment or its referenced AWS Secrets Manager/SSM values. No credentials are included in this repository.

### Database (required)

- `DATABASE_URL`, or `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD`
- `PGSSL=true` when the PostgreSQL provider requires TLS (the client uses `rejectUnauthorized: false` for managed-provider certificate chains)
- Optional pool tuning: `PGPOOL_MAX`, `PG_IDLE_TIMEOUT_MS`, `PG_CONNECT_TIMEOUT_MS`

### Telephony (optional)

- OmniDimension voice: `OMNIDIM_KEY`, `OMNIDIM_AGENT`, optional `OMNIDIM_FROM`
- Twilio fallback: `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM`
- Demo destination: `ALERT_PHONE`

The aliases `OMNIDIM_API_KEY`, `OMNIDIM_AGENT_ID`, `OMNIDIM_FROM_NUMBER_ID`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, and `JN_ALERT_PHONE` are also accepted. The telephony endpoint and alert dispatch read process environment variables supplied by deployment; provider secrets in `jn_config` are not read.

## Database setup

Run `schema.sql` against the target PostgreSQL database using the database owner's migration process. It creates `jn_api_keys`, `jn_incidents`, `jn_events`, `jn_contacts`, `jn_alerts`, and compatibility table `jn_config`, with constraints and indexes matching the current API fields.

The CDK stack packages this file with `dist/migrate.js` as a standalone Lambda. After deploying
the stack, invoke its `MigrationFunctionArn` CloudFormation output manually with AWS CLI; it loads
the RDS Secrets Manager JSON, connects with `PGHOST`/`PGPORT`/`PGDATABASE`, and runs the schema in
one transaction. It is intentionally not a deployment custom resource and does not run on every
deploy. See `../infra/README.md` for the exact invocation commands.

This initializes an empty schema only. It does **not** migrate Supabase rows, existing API keys,
roles, or configuration; those require a separate export/import and key recreation process.

The supplied row exports were imported in one transaction. A subsequent read-only check
confirmed 8 incidents, 29 events, 1 contact, 3 alerts and 3 API-key hashes.
`jalnetra-data-import` now performs read-only row-count verification; it no longer imports data.
The copied SQL files were removed from the application source and current Lambda packages.
Original attachments remain private. Historical provider payload fields were preserved as text.
`jn_config` was not imported. Provider-secret migration, rotation of previously exposed keys,
and frontend cutover are separate unfinished steps.

Example key hash generation (perform this in a secure administrative environment, never in a client):

```sh
node -e "console.log(require('node:crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" 'replace-with-a-team-key'
```

## Build

```sh
npm install
npm run typecheck
npm run build
```

`npm run build` writes JavaScript and source maps to `dist/`. This package intentionally does not edit the root application package or `src/backbone`.

## Migration limitations

- This is an API/runtime port, not a data migration. Existing Supabase rows, API keys, roles, and configuration are not copied.
- A deployment operator must migrate compatible data and create API-key hashes separately if continuity is required.
- PostgreSQL distance filtering is intentionally implemented with the same bounded query plus haversine calculation as the current API; PostGIS is not required.
- Provider dispatch is implemented for the existing OmniDimension/Twilio behavior, but this repository performs no provider calls during build or validation. Calls only occur when a deployed Lambda receives an alert request and the corresponding environment credentials are present.
- API Gateway authorizers, VPC networking, database migrations, Secrets Manager bindings, IAM, retries, and observability are deployment concerns outside this package.
