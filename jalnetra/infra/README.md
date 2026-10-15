# JalNetra AWS infrastructure

This directory is a self-contained AWS CDK TypeScript app for the JalNetra migration.
It deliberately changes only `infra/**`; the existing Vite app, API contract, and root
`package.json` are untouched.

## What is provisioned

- A two-AZ VPC with public, private-egress, and isolated subnets plus one NAT gateway. The
  API/jobs need private RDS access and outbound HTTPS to Secrets Manager/telephony; NAT is
  therefore intentional and billable.
- A small, single-AZ PostgreSQL 16 RDS instance in isolated subnets, encrypted, backed up,
  deletion-protected, and retained by default. Its generated admin credential is in Secrets
  Manager.
- Retained Secrets Manager placeholders for the migrated API and telephony integrations.
- An HTTP API backed by a Lambda placeholder. If `JALNETRA_API_SOURCE` is set, or a sibling
  `aws-api/` (or `api/aws-api/`) directory with `package.json` exists, that directory is
  packaged as the Lambda asset. A compiled `dist/handler.js` uses `dist/handler.handler`;
  otherwise the expected placeholder handler is `index.handler`.
- Cognito user pool plus a public SPA app client (`generateSecret: false`).
- Encrypted SQS alert queue with a 14-day dead-letter queue.
- Placeholder EventBridge Scheduler jobs for radar alerts every 15 minutes and incident
  re-verification every 3 hours. Both are **DISABLED by default**.
- Retained CloudWatch log groups and alarms for API Lambda errors, job Lambda errors, HTTP
  API 5xx responses, alert queue depth, and DLQ messages.
- A standalone, manually invoked schema-migration Lambda in the same private-egress subnets
  and security group as the API Lambda. It reads the RDS secret and runs `aws-api/schema.sql`
  in one PostgreSQL transaction; it is not a CloudFormation custom resource and does not run
  during deployment.
- CloudFormation outputs for endpoints, identifiers, queue resources, secret ARNs, migration
  function ARN, and schedule state.

The inline Lambda and scheduled worker return/log placeholder responses. They are wiring
scaffolds, not a production implementation of the API or pipeline jobs.

## Prerequisites

- Node.js 20+
- AWS credentials and a bootstrapped CDK environment in the target account/region

Install dependencies from this directory:

```sh
npm install
```

For an environment-specific deploy, set `CDK_DEFAULT_ACCOUNT` and `CDK_DEFAULT_REGION`, or
pass the usual CDK environment variables/configuration. The app is environment-agnostic for
synthesizing without credentials.

## Safe workflow

```sh
npm run build
npx cdk synth --strict
npx cdk diff
npx cdk deploy --require-approval broadening
```

Do not use `--hotswap` for this infrastructure. Review the diff carefully, especially RDS
logical IDs and subnet/security-group changes, before any deployment.

### Enabling schedules

Schedules remain disabled unless explicitly enabled at synth/deploy time:

```sh
npx cdk deploy -c enableSchedules=true --require-approval broadening
```

Deploying the schedules before the real worker and API are configured can create failed
invocations and alert traffic. The same context flag must be used for `cdk diff` when
reviewing that change.

### Optional API asset

The expected asset shape is a compiled Node.js Lambda package. The repository's current
`aws-api` build is ESM and exports `handler` from `dist/handler.js`; CDK detects that shape
automatically. Point CDK to another implementation without editing this app:

```sh
JALNETRA_API_SOURCE=../aws-api npx cdk synth --strict
```

On PowerShell:

```powershell
$env:JALNETRA_API_SOURCE = "..\aws-api"
npx cdk synth --strict
```

### Initialize the empty RDS schema (manual one-off)

After the stack is deployed, invoke the migration Lambda once with AWS CLI. It is deliberately
not invoked automatically by CloudFormation:

```sh
STACK_NAME=JalNetraInfraStack
MIGRATION_ARN=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?OutputKey==`MigrationFunctionArn`].OutputValue' \
  --output text)
aws lambda invoke \
  --function-name "$MIGRATION_ARN" \
  --payload '{}' \
  --cli-binary-format raw-in-base64-out \
  migration-response.json
cat migration-response.json
```

On PowerShell:

```powershell
$stackName = "JalNetraInfraStack"
$migrationArn = aws cloudformation describe-stacks --stack-name $stackName --query "Stacks[0].Outputs[?OutputKey=='MigrationFunctionArn'].OutputValue" --output text
aws lambda invoke --function-name $migrationArn --payload '{}' --cli-binary-format raw-in-base64-out migration-response.json
Get-Content .\migration-response.json
```

The response is `{ "success": true, "count": ... }`. This initializes an empty schema only;
it does **not** migrate Supabase rows, existing API keys, roles, or configuration. Plan and run
any data export/import and API-key recreation separately. The migration is safe to repeat because
the supplied schema uses idempotent `IF NOT EXISTS` statements, but it should still be treated as
a one-off administrative operation.

## Cost and data-migration warnings

- This is production-shaped but prototype-sized, not a low-cost always-free stack. RDS,
  storage, CloudWatch logs, Secrets Manager, API Gateway requests, Lambda, Cognito MAUs,
  SQS, and Scheduler can all incur charges. The single NAT gateway is especially expensive
  and is provisioned to give private Lambdas outbound access to Secrets Manager and providers.
- RDS is configured with `deletionProtection: true` and `RemovalPolicy.RETAIN`; deleting or
  replacing the stack will not delete the database automatically. Snapshot/restore and a
  tested rollback plan are still required.
- The database is empty infrastructure. No Supabase schema, rows, API keys, contacts,
  incidents, or evidence are migrated by this CDK app. Plan an explicit export, transform,
  validation, import, and cutover/rollback process before changing the API endpoint.
- Secret values are placeholders. Replace them through a controlled Secrets Manager process;
  do not commit credentials, put them in `cdk.json`, or expose operator keys to the SPA.
- The optional `aws-api` asset receives the RDS endpoint, database name/user, TLS setting,
  and database secret ARN. Its runtime must resolve that ARN to obtain the password (or use a
  separate credential-loading mechanism) before it can query PostgreSQL; this stack does not
  place the database password in Lambda environment variables.
- Cognito self-sign-up is enabled for prototype use. Review domains, email delivery, MFA,
  allowed callback/logout URLs, and account-recovery policy before production.
- The current frontend still points at the existing prototype API contract. CDK outputs do
  not update the frontend automatically.
