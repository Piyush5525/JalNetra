import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { Client } from "pg";

const secrets = new SecretsManagerClient({});

async function main() {
  const secretId = process.env.JALNETRA_DATABASE_SECRET_ARN;
  if (!secretId || !process.env.PGHOST || !process.env.PGDATABASE) throw new Error("Database migration environment is incomplete");
  const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretId }));
  const db = JSON.parse(result.SecretString ?? "{}") as { username?: string; password?: string };
  if (!db.username || !db.password) throw new Error("Database secret is incomplete");
  const client = new Client({ host: process.env.PGHOST, port: Number(process.env.PGPORT ?? 5432), database: process.env.PGDATABASE, user: db.username, password: db.password, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    // The import has completed. This entry point is now read-only so retries
    // cannot replay historical alerts or insert the same export again.
    const tables = ['jn_api_keys', 'jn_incidents', 'jn_contacts', 'jn_events', 'jn_alerts'];
    const counts: Record<string, number> = {};
    await client.query('BEGIN READ ONLY');
    for (const table of tables) {
      const result = await client.query(`SELECT count(*)::int AS count FROM ${table}`);
      counts[table] = result.rows[0].count;
    }
    await client.query('COMMIT');
    return { success: true, mode: 'verify', counts };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export const handler = async () => main();
export default handler;
