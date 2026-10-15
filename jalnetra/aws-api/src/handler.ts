import { createHash } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2, Handler } from "aws-lambda";
import { query, transaction } from "./db.js";
import { dispatchAlert, selectedProvider, telephonyConfig, type AlertChannel } from "./telephony.js";
import { loadRuntimeSecrets } from "./secrets.js";
import { routeDemo, routeDemoPublic, type DemoReply } from "./demo.js";
import { routeForecastProxy } from "./proxy.js";
import { notifyApproval, routeExtras } from "./extras.js";

type JsonObject = Record<string, unknown>;
type ApiKey = { owner: string; role: "reporter" | "operator" | string };
type Incident = JsonObject & { id: string; lat: number; lng: number; status: string; severity: string; reports: number; confidence: number };

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-jalnetra-key, authorization, apikey",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};
const TYPES = ["river_flood", "waterlogging", "pothole", "leak"] as const;
const SEVERITIES = ["low", "medium", "high"] as const;
const SOURCES = ["satellite", "forecast", "cctv", "dashcam", "app", "whatsapp", "sms", "call", "sensor"] as const;
const OPEN = ["detected", "approved", "ticketed", "reopened", "escalated", "fixed_claimed"];
const SLA_HOURS: Record<string, number> = { high: 6, medium: 24, low: 72 };
const NEXT: Record<string, string[]> = {
  detected: ["approved", "rejected"],
  approved: ["ticketed", "rejected"],
  ticketed: ["fixed_claimed", "escalated"],
  fixed_claimed: ["verified", "reopened"],
  reopened: ["ticketed", "escalated"],
  escalated: ["ticketed", "fixed_claimed"],
  rejected: [],
  verified: [],
};
const CONTACT_ROLES = ["sarpanch", "asha", "ngo", "official", "volunteer"];

const demoResult = (reply: DemoReply): APIGatewayProxyStructuredResultV2 => ({
  statusCode: reply.status,
  headers: { ...CORS_HEADERS, "content-type": "application/json", ...(reply.headers ?? {}) },
  body: JSON.stringify(reply.body),
});

const json = (body: unknown, status = 200): APIGatewayProxyStructuredResultV2 => ({
  statusCode: status,
  headers: { ...CORS_HEADERS, "content-type": "application/json" },
  body: JSON.stringify(body),
});

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBody(event: APIGatewayProxyEventV2): JsonObject | null {
  if (!event.body) return null;
  try {
    const body = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    const parsed: unknown = JSON.parse(body);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function pathFor(event: APIGatewayProxyEventV2): string {
  const raw = event.rawPath || event.requestContext.http.path || "/";
  const withoutStage = raw.replace(/^.*\/jalnetra-api(?=\/|$)/, "") || "/";
  return withoutStage.startsWith("/") ? withoutStage : `/${withoutStage}`;
}

function header(event: APIGatewayProxyEventV2, name: string): string | undefined {
  const wanted = name.toLowerCase();
  const entry = Object.entries(event.headers ?? {}).find(([key]) => key.toLowerCase() === wanted);
  return entry?.[1];
}

function withFlags(incident: JsonObject): JsonObject {
  const due = text(incident.sla_due);
  const status = text(incident.status) ?? "";
  return { ...incident, overdue: Boolean(due && OPEN.includes(status) && status !== "fixed_claimed" && new Date(due).getTime() < Date.now()) };
}

function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const radians = Math.PI / 180;
  const deltaLat = (b.lat - a.lat) * radians;
  const deltaLng = (b.lng - a.lng) * radians;
  const h = Math.sin(deltaLat / 2) ** 2 + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(deltaLng / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(h));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function authenticate(event: APIGatewayProxyEventV2): Promise<ApiKey | null> {
  const key = header(event, "x-jalnetra-key");
  if (!key) return null;
  const result = await query<ApiKey>("SELECT owner, role FROM jn_api_keys WHERE key_hash = $1 LIMIT 1", [sha256(key)]);
  return result.rows[0] ?? null;
}

function idMatch(path: string): string | null {
  return path.match(/^\/incidents\/([0-9a-f-]{36})$/i)?.[1] ?? null;
}

function appendIn(values: unknown[], items: string[]): string {
  return items.map((item) => {
    values.push(item);
    return `$${values.length}`;
  }).join(", ");
}

async function createIncident(body: JsonObject, who: ApiKey): Promise<APIGatewayProxyStructuredResultV2> {
  const incidentType = text(body.incident_type);
  const severity = text(body.severity);
  const source = text(body.source);
  const lat = number(body.lat);
  const lng = number(body.lng);
  const confidence = body.confidence === undefined ? 0.5 : number(body.confidence);
  const errors: string[] = [];
  if (!incidentType || !TYPES.includes(incidentType as typeof TYPES[number])) errors.push(`incident_type must be one of ${TYPES.join(", ")}`);
  if (!severity || !SEVERITIES.includes(severity as typeof SEVERITIES[number])) errors.push(`severity must be one of ${SEVERITIES.join(", ")}`);
  if (!source || !SOURCES.includes(source as typeof SOURCES[number])) errors.push(`source must be one of ${SOURCES.join(", ")}`);
  if (lat === undefined || lng === undefined) errors.push("lat and lng must be numbers");
  if (confidence === undefined || confidence < 0 || confidence > 1) errors.push("confidence must be between 0 and 1");
  if (errors.length) return json({ error: "Invalid incident", details: errors }, 400);

  const radius = incidentType === "river_flood" ? 3_000 : 150;
  const since = new Date(Date.now() - 6 * 3_600_000).toISOString();
  return transaction(async (client) => {
    const nearby = await client.query<Incident>(
      `SELECT * FROM jn_incidents
       WHERE incident_type = $1 AND status = ANY($2::text[]) AND updated_at >= $3
         AND lat BETWEEN $4 AND $5 AND lng BETWEEN $6 AND $7`,
      [incidentType, OPEN, since, lat! - 0.03, lat! + 0.03, lng! - 0.03, lng! + 0.03],
    );
    const duplicate = nearby.rows.find((candidate) => metres(candidate, { lat: lat!, lng: lng! }) <= radius);
    if (duplicate) {
      const nextConfidence = Math.min(1, Math.max(duplicate.confidence, confidence!) + 0.05);
      const nextSeverity = SEVERITIES.indexOf(severity as typeof SEVERITIES[number]) > SEVERITIES.indexOf(duplicate.severity as typeof SEVERITIES[number]) ? severity! : duplicate.severity;
      const tighterSla = new Date(Date.now() + SLA_HOURS[nextSeverity] * 3_600_000).toISOString();
      const slaDue = duplicate.sla_due && new Date(String(duplicate.sla_due)) < new Date(tighterSla) ? duplicate.sla_due : tighterSla;
      const updated = await client.query<Incident>(
        "UPDATE jn_incidents SET reports = reports + 1, confidence = $1, severity = $2, sla_due = $3, updated_at = now() WHERE id = $4 RETURNING *",
        [nextConfidence, nextSeverity, slaDue, duplicate.id],
      );
      await client.query("INSERT INTO jn_events (incident_id, action, actor, note, data) VALUES ($1, $2, $3, $4, $5)", [duplicate.id, "duplicate_report", who.owner, `Another report from ${source}`, { evidence_url: body.evidence_url ?? null }]);
      return json({ merged: true, incident: withFlags(updated.rows[0]) });
    }

    const slaDue = new Date(Date.now() + SLA_HOURS[severity!] * 3_600_000).toISOString();
    const inserted = await client.query<Incident>(
      `INSERT INTO jn_incidents
       (incident_type, severity, confidence, lat, lng, observed_at, source, language, title, evidence_url, details, reported_by, sla_due)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
      [incidentType, severity, confidence, lat, lng, body.observed_at ?? new Date().toISOString(), source, body.language ?? "hi", body.title ?? null, body.evidence_url ?? null, isObject(body.details) ? body.details : {}, who.owner, slaDue],
    );
    const incident = inserted.rows[0];
    await client.query("INSERT INTO jn_events (incident_id, action, actor, note, data) VALUES ($1, $2, $3, $4, $5)", [incident.id, "detected", who.owner, body.title ?? null, { source }]);
    return json({ merged: false, incident: withFlags(incident) }, 201);
  });
}

async function listIncidents(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const values: unknown[] = [];
  const conditions: string[] = [];
  const type = event.queryStringParameters?.type;
  const status = event.queryStringParameters?.status;
  const bbox = event.queryStringParameters?.bbox;
  if (type) conditions.push(`incident_type IN (${appendIn(values, type.split(","))})`);
  if (status) conditions.push(`status IN (${appendIn(values, status.split(","))})`);
  if (bbox) {
    const bounds = bbox.split(",").map(Number);
    if (bounds.length !== 4 || bounds.some((value) => !Number.isFinite(value))) return json({ error: "bbox must be west,south,east,north" }, 400);
    conditions.push(`lng BETWEEN $${values.push(bounds[0])} AND $${values.push(bounds[2])} AND lat BETWEEN $${values.push(bounds[1])} AND $${values.push(bounds[3])}`);
  }
  const requestedLimit = Number(event.queryStringParameters?.limit ?? 200);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 1000) : 200;
  values.push(limit);
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await query<Incident>(`SELECT * FROM jn_incidents ${where} ORDER BY created_at DESC LIMIT $${values.length}`, values);
  return json({ incidents: rows.rows.map(withFlags) });
}

async function getIncident(id: string): Promise<APIGatewayProxyStructuredResultV2> {
  const incident = await query<Incident>("SELECT * FROM jn_incidents WHERE id = $1", [id]);
  if (!incident.rows[0]) return json({ error: "Incident not found" }, 404);
  const events = await query("SELECT * FROM jn_events WHERE incident_id = $1 ORDER BY created_at", [id]);
  return json({ incident: withFlags(incident.rows[0]), events: events.rows });
}

async function patchIncident(id: string, body: JsonObject | null, who: ApiKey): Promise<APIGatewayProxyStructuredResultV2> {
  if (who.role !== "operator") return json({ error: "Only operator keys can change status" }, 403);
  if (!body) return json({ error: "Body must be JSON" }, 400);
  const incident = await query<Incident>("SELECT * FROM jn_incidents WHERE id = $1", [id]);
  const current = incident.rows[0];
  if (!current) return json({ error: "Incident not found" }, 404);
  const next = text(body.status);
  if (!next || !NEXT[current.status]?.includes(next)) return json({ error: `Cannot move from ${current.status} to ${next}`, allowed: NEXT[current.status] ?? [] }, 409);
  const slaDue = next === "reopened" ? new Date(Date.now() + SLA_HOURS[current.severity] * 3_600_000).toISOString() : current.sla_due;
  const updated = await query<Incident>("UPDATE jn_incidents SET status = $1, sla_due = $2, updated_at = now() WHERE id = $3 RETURNING *", [next, slaDue, id]);
  await query("INSERT INTO jn_events (incident_id, action, actor, note, data) VALUES ($1, $2, $3, $4, $5)", [id, next, who.owner, body.note ?? null, { evidence_url: body.evidence_url ?? null }]);
  return json({ incident: withFlags(updated.rows[0]) });
}

async function addEvidence(id: string, body: JsonObject | null, who: ApiKey): Promise<APIGatewayProxyStructuredResultV2> {
  if (!body) return json({ error: "Body must be JSON" }, 400);
  const note = text(body.note);
  if (!note) return json({ error: "note is required" }, 400);
  const incident = await query<{ id: string }>("SELECT id FROM jn_incidents WHERE id = $1", [id]);
  if (!incident.rows[0]) return json({ error: "Incident not found" }, 404);
  await query("INSERT INTO jn_events (incident_id, action, actor, note, data) VALUES ($1, $2, $3, $4, $5)", [id, "evidence", who.owner, note, { ...(isObject(body.data) ? body.data : {}), evidence_url: body.evidence_url ?? null }]);
  await query("UPDATE jn_incidents SET updated_at = now() WHERE id = $1", [id]);
  return json({ ok: true }, 201);
}

async function contacts(event: APIGatewayProxyEventV2, body: JsonObject | null, who: ApiKey): Promise<APIGatewayProxyStructuredResultV2> {
  if (event.requestContext.http.method === "GET") {
    const lat = Number(event.queryStringParameters?.lat);
    const lng = Number(event.queryStringParameters?.lng);
    const km = Number(event.queryStringParameters?.km ?? 15);
    const rows = await query("SELECT * FROM jn_contacts ORDER BY created_at DESC LIMIT 1000");
    let result = rows.rows as Array<JsonObject & { lat: number; lng: number }>;
    if (Number.isFinite(lat) && Number.isFinite(lng) && event.queryStringParameters?.lat !== undefined) {
      result = result.map((contact) => ({ ...contact, km: metres(contact, { lat, lng }) / 1000 })).filter((contact) => Number(contact.km) <= km).sort((a, b) => Number(a.km) - Number(b.km));
    }
    return json({ contacts: result });
  }
  if (who.role !== "operator") return json({ error: "Only operator keys can add contacts" }, 403);
  if (!body) return json({ error: "Body must be JSON" }, 400);
  const role = text(body.role);
  const name = text(body.name);
  const placeName = text(body.place_name);
  const phone = String(body.phone ?? "").replace(/[\s-]/g, "");
  const lat = number(body.lat);
  const lng = number(body.lng);
  if (!name || !role || !CONTACT_ROLES.includes(role) || !/^\+[1-9]\d{7,14}$/.test(phone) || !placeName || lat === undefined || lng === undefined) {
    return json({ error: "Invalid contact: name, role (sarpanch|asha|ngo|official|volunteer), phone in +91... format, place_name, lat, lng are required" }, 400);
  }
  const inserted = await query("INSERT INTO jn_contacts (name, role, phone, place_name, district, lat, lng, language, added_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *", [name, role, phone, placeName, body.district ?? null, lat, lng, body.language ?? "hi", who.owner]);
  return json({ contact: inserted.rows[0] }, 201);
}

async function telephony(): Promise<APIGatewayProxyStructuredResultV2> {
  // Report the same provider decision used by POST /alerts. Previously this
  // endpoint treated a Twilio SID alone as configured, while dispatchAlert
  // correctly required SID, token, and from-number. That made the dashboard
  // claim a provider was ready even though sending returned not_configured.
  const call = selectedProvider("call");
  const sms = selectedProvider("sms");
  const phone = telephonyConfig().alertPhone;
  return json({ call, sms, demo_phone: phone ? `${phone.slice(0, 3)}******${phone.slice(-4)}` : null });
}

async function alerts(id: string, event: APIGatewayProxyEventV2, body: JsonObject | null, who: ApiKey): Promise<APIGatewayProxyStructuredResultV2> {
  if (event.requestContext.http.method === "GET") {
    const rows = await query<JsonObject & { contact_id: string | null }>(
      `SELECT a.*, c.name AS contact_name, c.role AS contact_role, c.phone AS contact_phone, c.place_name AS contact_place_name
       FROM jn_alerts a LEFT JOIN jn_contacts c ON c.id = a.contact_id
       WHERE a.incident_id = $1 ORDER BY a.created_at DESC`, [id],
    );
    return json({ alerts: rows.rows.map(({ contact_name, contact_role, contact_phone, contact_place_name, ...alert }) => ({
      ...alert,
      jn_contacts: alert.contact_id ? { name: contact_name, role: contact_role, phone: contact_phone, place_name: contact_place_name } : null,
    })) });
  }
  if (who.role !== "operator") return json({ error: "Only operator keys can send alerts" }, 403);
  if (!body) return json({ error: "Body must be JSON" }, 400);
  const contactIds = Array.isArray(body.contact_ids) ? body.contact_ids.filter((value): value is string => typeof value === "string") : [];
  const demo = body.demo === true;
  const message = text(body.message);
  const channel: AlertChannel = body.channel === "sms" ? "sms" : "call";
  if (!contactIds.length && !demo) return json({ error: "Pick at least one contact" }, 400);
  if (!message) return json({ error: "message is required" }, 400);
  const incident = await query<{ id: string; status: string }>("SELECT id, status FROM jn_incidents WHERE id = $1", [id]);
  const current = incident.rows[0];
  if (!current) return json({ error: "Incident not found" }, 404);
  if (!["approved", "ticketed", "contacted", "evacuating"].includes(current.status)) return json({ error: `Incident must be approved before sending alerts (current status: ${current.status})` }, 409);
  const found = contactIds.length ? await query<JsonObject & { id: string; name: string; phone: string }>(`SELECT * FROM jn_contacts WHERE id IN (${appendIn([], contactIds)})`, contactIds) : { rows: [] as Array<JsonObject & { id: string; name: string; phone: string }> };
  if (!demo && found.rows.length === 0) return json({ error: "No matching alert contacts found" }, 400);
  const config = telephonyConfig();
  const targets: Array<{ id: string | null; name: string; phone: string }> = found.rows.map((contact) => ({ id: contact.id, name: contact.name, phone: contact.phone }));
  if (demo && config.alertPhone) targets.push({ id: null, name: "Demo phone", phone: config.alertPhone });
  if (!targets.length) return json({ error: "No alert recipients configured" }, 400);
  const provider = selectedProvider(channel);
  const context = isObject(body.context) ? body.context as { place?: string; title?: string; source?: string; observed?: string; safe_place?: string } : {};
  const results: Array<{ contact: string; phone: string; status: string; error: string | null }> = [];
  for (const target of targets) {
    const result = await dispatchAlert(provider, channel, target, message, context, id);
    await query("INSERT INTO jn_alerts (incident_id, contact_id, channel, message, status, provider_ref, error, sent_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)", [id, target.id, channel, message, result.status, result.providerRef, result.error, who.owner]);
    results.push({ contact: target.name, phone: target.phone, status: result.status, error: result.error });
  }
  await query("INSERT INTO jn_events (incident_id, action, actor, note, data) VALUES ($1, $2, $3, $4, $5)", [id, "alert", who.owner, `${channel === "call" ? "Voice call" : "SMS"} to ${results.length} contact(s): ${results.filter((result) => result.status === "sent").length} sent`, { results }]);
  return json({ telephony: provider, results });
}

export const handler: Handler = async (event: APIGatewayProxyEventV2) => {
  await loadRuntimeSecrets();
  const method = event.requestContext.http.method;
  if (method === "OPTIONS") return { statusCode: 204, headers: CORS_HEADERS };
  const path = pathFor(event);
  if (method === "GET" && path === "/health") return json({ ok: true, time: new Date().toISOString() });
  // Cached pass-through to the free Open-Meteo APIs, so browsers never hit its per-IP rate limits. Read-only, allow-listed.
  const proxied = await routeForecastProxy(method, path, event.rawQueryString ?? "");
  if (proxied) return { statusCode: proxied.status, headers: { ...CORS_HEADERS, "Access-Control-Expose-Headers": "x-jalnetra-cache, x-jalnetra-cached-at", ...proxied.headers }, body: proxied.body };
  // AWS-powered helpers (Polly speech, Bedrock draft, Location walking route, Rekognition photo check). Stateless and rate-limited.
  if (path.startsWith("/ai/")) {
    const extra = await routeExtras(method, path, event.queryStringParameters ?? {}, parseBody(event), event.requestContext.http.sourceIp ?? "unknown");
    if (extra) return { statusCode: extra.status, headers: { ...CORS_HEADERS, "content-type": "application/json" }, body: JSON.stringify(extra.body) };
  }
  // Anonymous read-only exercise feed (unguessable session id, sanitised projection). Never mutates, never calls.
  const publicDemo = await routeDemoPublic(method, path);
  if (publicDemo) return demoResult(publicDemo);

  try {
    let who = await authenticate(event);
    // Public exercise mode: the /demo/* exercise routes may run without an operator key. Everything such a caller does is
    // attributed to one shared "public-demo" principal, so the server-side limits (3 calls per session, 30 s cooldown,
    // 10 calls per 24 h) act as one global cap. A call can only ever reach the server-configured demo phone: no route
    // accepts a number. Every other route (incidents, contacts, alerts) still requires a real key. Set
    // JALNETRA_PUBLIC_DEMO to anything other than "true" to turn this off.
    if (!who && process.env.JALNETRA_PUBLIC_DEMO === "true" && path.startsWith("/demo/")) who = { owner: "public-demo", role: "operator" };
    if (!who) {
      const error = header(event, "x-jalnetra-key") ? "Unknown API key" : "Missing x-jalnetra-key header";
      return json(path.startsWith("/demo/") ? { error, code: "UNAUTHENTICATED" } : { error }, 401);
    }
    const body = parseBody(event);
    if (path.startsWith("/demo/")) {
      const demo = await routeDemo(method, path, who, body);
      if (demo) {
        // approval -> SNS topic + follow-up workflow (best effort, never blocks or changes the approval)
        if (method === "POST" && /\/approve$/.test(path)) await notifyApproval(demo);
        return demoResult(demo);
      }
    }
    if (method === "POST" && path === "/incidents") {
      if (!body) return json({ error: "Body must be JSON" }, 400);
      return await createIncident(body, who);
    }
    if (method === "GET" && path === "/incidents") return await listIncidents(event);
    const incidentId = idMatch(path);
    if (incidentId && method === "GET") return await getIncident(incidentId);
    if (incidentId && method === "PATCH") return await patchIncident(incidentId, body, who);
    const evidenceId = path.match(/^\/incidents\/([0-9a-f-]{36})\/evidence$/i)?.[1];
    if (evidenceId && method === "POST") return await addEvidence(evidenceId, body, who);
    if (method === "GET" && path === "/telephony") return await telephony();
    if ((method === "GET" || method === "POST") && path === "/contacts") return await contacts(event, body, who);
    const alertId = path.match(/^\/incidents\/([0-9a-f-]{36})\/alerts$/i)?.[1];
    if (alertId && (method === "GET" || method === "POST")) return await alerts(alertId, event, body, who);
    return json({ error: `No route for ${method} ${path}` }, 404);
  } catch (error) {
    console.error("JalNetra API request failed", error);
    return json({ error: "Internal server error" }, 500);
  }
};

export default handler;
