import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const client = new SecretsManagerClient({});
const loaded = new Set<string>();

async function readJson(arn: string): Promise<Record<string, unknown>> {
  const result = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!result.SecretString) throw new Error(`Secret ${arn} has no SecretString value`);
  const parsed: unknown = JSON.parse(result.SecretString);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Secret ${arn} must contain a JSON object`);
  return parsed as Record<string, unknown>;
}

function apply(values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" && value.length > 0 && !process.env[key]) process.env[key] = value;
  }
}

export async function loadRuntimeSecrets() {
  const databaseArn = process.env.JALNETRA_DATABASE_SECRET_ARN;
  if (databaseArn && !loaded.has(databaseArn)) {
    const db = await readJson(databaseArn);
    apply({ PGPASSWORD: db.password, PGHOST: process.env.PGHOST ?? db.host, PGPORT: process.env.PGPORT ?? String(db.port ?? 5432), PGDATABASE: process.env.PGDATABASE ?? db.dbname, PGUSER: process.env.PGUSER ?? db.username });
    loaded.add(databaseArn);
  }
  const telephonyArn = process.env.JALNETRA_TELEPHONY_SECRET_ARN;
  if (telephonyArn && !loaded.has(telephonyArn)) {
    const telephony = await readJson(telephonyArn);
    apply({
      OMNIDIM_KEY: telephony.OMNIDIM_KEY ?? telephony.omnidimKey,
      OMNIDIM_AGENT: telephony.OMNIDIM_AGENT ?? telephony.omnidimAgent,
      OMNIDIM_FROM: telephony.OMNIDIM_FROM ?? telephony.omnidimFrom,
      TWILIO_SID: telephony.TWILIO_SID ?? telephony.accountId,
      TWILIO_TOKEN: telephony.TWILIO_TOKEN ?? telephony.authToken,
      TWILIO_FROM: telephony.TWILIO_FROM ?? telephony.from,
      ALERT_PHONE: telephony.ALERT_PHONE ?? telephony.alertPhone,
    });
    loaded.add(telephonyArn);
  }
}
