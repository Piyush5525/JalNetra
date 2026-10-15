import { readFile } from "node:fs/promises";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { Client } from "pg";

const secretsManager = new SecretsManagerClient({});

type DatabaseSecret = {
  username?: unknown;
  password?: unknown;
};

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

async function loadDatabaseSecret(secretId: string): Promise<DatabaseSecret> {
  const result = await secretsManager.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!result.SecretString) throw new Error(`Secret ${secretId} has no SecretString value`);

  const parsed: unknown = JSON.parse(result.SecretString);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Secret ${secretId} must contain a JSON object`);
  }
  return parsed as DatabaseSecret;
}

function statementCount(schema: string): number {
  return schema
    .split(";")
    .map((statement) => statement.replace(/--.*$/gm, "").trim())
    .filter(Boolean).length;
}

export const handler = async (): Promise<{ success: true; count: number }> => {
  const secretId = requiredEnvironment("JALNETRA_DATABASE_SECRET_ARN");
  const host = requiredEnvironment("PGHOST");
  const port = Number(requiredEnvironment("PGPORT"));
  const database = requiredEnvironment("PGDATABASE");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PGPORT must be a valid TCP port");

  const secret = await loadDatabaseSecret(secretId);
  if (typeof secret.username !== "string" || !secret.username) throw new Error("Database secret username is missing");
  if (typeof secret.password !== "string" || !secret.password) throw new Error("Database secret password is missing");

  const schema = await readFile(new URL("../schema.sql", import.meta.url), "utf8");
  const client = new Client({
    host,
    port,
    database,
    user: secret.username,
    password: secret.password,
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined,
  });

  let connected = false;
  try {
    await client.connect();
    connected = true;
    await client.query("BEGIN");
    await client.query(schema);
    await client.query("COMMIT");
    return { success: true, count: statementCount(schema) };
  } catch (error) {
    if (connected) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
};

export default handler;
