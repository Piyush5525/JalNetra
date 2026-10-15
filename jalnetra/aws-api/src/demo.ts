// Conduct Demo backend: five fixed exercise alerts per session, isolated from real incidents.
//
// Safety properties enforced here, never in the browser:
//  * Isolation: only jn_demo_* tables are touched. jn_incidents, jn_alerts and jn_contacts are never
//    read or written, so incident de-duplication/merging cannot mix demo and real data.
//  * Server-only destination: the call goes to the server-configured ALERT_PHONE through OmniDimension.
//    Request bodies cannot carry phones, contacts, channels or message text (FIELD_NOT_ALLOWED).
//  * No call from creating, reading or listing. Only an explicit operator approval can reserve one.
//  * At most one call attempt per alert, ever: a UNIQUE ledger row per alert. No automatic retry.
//  * Approval, frozen prediction reference, call reservation and ledger row are persisted in ONE
//    transaction, under a per-operator row lock, BEFORE the provider is contacted.
//  * A rejected request (cooldown/allowance) leaves approval untouched.
//  * Provider "sent" means dispatched, not answered. Timeouts/network errors/5xx are "unknown".
import { randomUUID } from "node:crypto";
import { transaction } from "./db.js";
import { dispatchAlert, selectedProvider, telephonyConfig, type TelephonyProvider } from "./telephony.js";
import {
  HORIZONS,
  PUBLIC_BANNER,
  SCENARIOS,
  SCENARIO_VERSION,
  alertTitle,
  findScenario,
  isHorizon,
  messageEn,
  messageHi,
  predictionReference,
  type Horizon,
  type PredictionReference,
} from "./demoScenarios.js";

// ---- limits (accepted values) ----
export const COOLDOWN_SECONDS = 30;
export const SESSION_CALLS_MAX = 3;
export const OPERATOR_CALLS_PER_24H = 10;
export const PROVIDER_TIMEOUT_MS = 10_000;
/** A call left in "dispatching" this long is reported as "unknown" (the worker died or never recorded an outcome). */
export const DISPATCHING_STALE_MS = 60_000;

// ---- contract types ----
export type ApprovalStatus = "pending" | "approved";
export type CallStatus = "not_requested" | "dispatching" | "dispatched" | "failed" | "not_configured" | "unknown";
export type DemoDestination = { configured: boolean; masked: string | null; provider: "omnidimension" | "twilio" | "not_configured" };
export type DemoAlert = {
  id: string;
  order: 1 | 2 | 3 | 4 | 5;
  title: string;
  exercise: true;
  messageHi: string;
  messageEn: string;
  prediction: PredictionReference;
  approvalStatus: ApprovalStatus;
  approvedAt: string | null;
  approvedBy: string | null;
  callStatus: CallStatus;
  callAttempts: 0 | 1;
  callUpdatedAt: string | null;
  callNote: string | null;
};
export type Allowance = { callsUsed: number; callsMax: number; cooldownSeconds: number; nextCallAllowedAt: string | null };
export type DemoSession = {
  id: string;
  createdAt: string;
  createdBy: string;
  scenarioVersion: string;
  exercise: true;
  demoDestination: DemoDestination;
  allowance: Allowance;
  alerts: DemoAlert[];
};
export type DemoApprovalResult = { replayed: boolean; alert: DemoAlert; session: Pick<DemoSession, "allowance"> };
export type PublicDemoFeed = {
  exercise: true;
  banner: typeof PUBLIC_BANNER;
  sessionId: string;
  generatedAt: string;
  items: Array<{
    id: string;
    order: number;
    title: string;
    messageHi: string;
    messageEn: string;
    prediction: PredictionReference;
    approvedAt: string;
    demoCall: "dispatched" | "not_confirmed";
  }>;
};

export type DemoReply = { status: number; body: unknown; headers?: Record<string, string> };

// ---- storage interface (Postgres implementation below, in-memory one in tests) ----
export type SessionRow = { id: string; owner: string; requestId: string; scenarioVersion: string; createdAt: string };
export type AlertRow = {
  id: string;
  sessionId: string;
  ord: number;
  scenarioId: string;
  approvalStatus: ApprovalStatus;
  approvedAt: string | null;
  approvedBy: string | null;
  approveRequestId: string | null;
  horizonHours: number | null;
  predictionDigest: string | null;
  predictionRef: PredictionReference | null;
  callStatus: CallStatus;
  callAttempts: number;
  callUpdatedAt: string | null;
};
export type ApplyApproval = {
  approvedAt: string;
  approvedBy: string;
  requestId: string;
  horizonHours: Horizon;
  predictionDigest: string | null;
  predictionRef: PredictionReference;
  callStatus: "dispatching" | "not_configured";
  /** true only when a call is reserved: also inserts the ledger row. */
  reserve: boolean;
};
export interface DemoTx {
  getSession(id: string): Promise<SessionRow | null>;
  findSessionByRequest(owner: string, requestId: string): Promise<SessionRow | null>;
  insertSession(session: SessionRow, alerts: Array<{ id: string; ord: number; scenarioId: string }>): Promise<void>;
  getAlerts(sessionId: string): Promise<AlertRow[]>;
  getAlertForUpdate(sessionId: string, alertId: string): Promise<AlertRow | null>;
  ledgerCountSession(sessionId: string): Promise<number>;
  ledgerCountOwnerSince(owner: string, sinceIso: string): Promise<number>;
  ledgerLastOwner(owner: string): Promise<string | null>;
  applyApproval(alert: AlertRow, owner: string, sessionId: string, change: ApplyApproval): Promise<void>;
  setOutcome(alertId: string, status: CallStatus, providerRef: string | null, atIso: string): Promise<boolean>;
}
export interface DemoStore {
  /** With an owner: serialised per operator (row lock). Without: plain read transaction. */
  transaction<T>(owner: string | null, work: (tx: DemoTx) => Promise<T>): Promise<T>;
}

export type DemoDeps = {
  store: DemoStore;
  dispatch: typeof dispatchAlert;
  config: () => { alertPhone?: string; provider: TelephonyProvider };
  now: () => Date;
  uuid: () => string;
  log?: (message: string, data?: unknown) => void;
};

// ---- helpers ----
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const reply = (status: number, body: unknown, headers?: Record<string, string>): DemoReply => ({ status, body, headers });
const fail = (status: number, code: string, error: string, details?: unknown, headers?: Record<string, string>) =>
  reply(status, details === undefined ? { error, code } : { error, code, details }, headers);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const mask = (phone?: string) => (phone ? `${phone.slice(0, 3)}******${phone.slice(-4)}` : null);

function checkBody(body: unknown, allowed: string[]): DemoReply | Record<string, unknown> {
  if (!isObject(body)) return fail(400, "INVALID_BODY", "Body must be a JSON object");
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length) return fail(400, "FIELD_NOT_ALLOWED", "Only server-owned fields are used in the demo workflow. Remove the extra fields.", { fields: extra });
  return body;
}
const isReply = (value: unknown): value is DemoReply => isObject(value) && typeof value.status === "number" && "body" in value;

function callNote(status: CallStatus): string | null {
  switch (status) {
    case "dispatched": return "Dispatch is not confirmation it was answered.";
    case "unknown": return "Provider outcome unknown. The call may or may not have been placed. It will not be retried.";
    case "failed": return "The provider rejected the request. No call was placed.";
    case "not_configured": return "Demo phone or OmniDimension is not configured on the server. No call was placed.";
    case "dispatching": return "Call request in progress.";
    default: return null;
  }
}

export function createDemoApi(deps: DemoDeps) {
  const log = deps.log ?? (() => undefined);

  const destination = (): DemoDestination => {
    const config = deps.config();
    return { configured: Boolean(config.alertPhone) && config.provider === "omnidimension", masked: mask(config.alertPhone), provider: config.provider };
  };

  function toAlert(row: AlertRow, operator: boolean): DemoAlert {
    const scenario = findScenario(row.scenarioId)!;
    let status = row.callStatus;
    if (status === "dispatching" && row.callUpdatedAt && deps.now().getTime() - Date.parse(row.callUpdatedAt) > DISPATCHING_STALE_MS) status = "unknown";
    return {
      id: row.id,
      order: scenario.order,
      title: alertTitle(scenario),
      exercise: true,
      messageHi: messageHi(scenario),
      messageEn: messageEn(scenario),
      prediction: row.predictionRef ?? predictionReference(scenario, null, null),
      approvalStatus: row.approvalStatus,
      approvedAt: row.approvedAt,
      approvedBy: operator ? row.approvedBy : null,
      callStatus: status,
      callAttempts: row.callAttempts === 1 ? 1 : 0,
      callUpdatedAt: row.callUpdatedAt,
      callNote: callNote(status),
    };
  }

  async function allowance(tx: DemoTx, owner: string, sessionId: string): Promise<Allowance> {
    const used = await tx.ledgerCountSession(sessionId);
    const last = await tx.ledgerLastOwner(owner);
    const next = last ? new Date(Date.parse(last) + COOLDOWN_SECONDS * 1000) : null;
    return { callsUsed: used, callsMax: SESSION_CALLS_MAX, cooldownSeconds: COOLDOWN_SECONDS, nextCallAllowedAt: next && next > deps.now() ? next.toISOString() : null };
  }

  async function sessionDto(tx: DemoTx, session: SessionRow): Promise<DemoSession> {
    const rows = await tx.getAlerts(session.id);
    return {
      id: session.id,
      createdAt: session.createdAt,
      createdBy: session.owner,
      scenarioVersion: session.scenarioVersion,
      exercise: true,
      demoDestination: destination(),
      allowance: await allowance(tx, session.owner, session.id),
      alerts: rows.map((row) => toAlert(row, true)),
    };
  }

  // POST /demo/sessions
  async function createSession(owner: string, role: string, rawBody: unknown): Promise<DemoReply> {
    if (role !== "operator") return fail(403, "FORBIDDEN_ROLE", "Only operator keys can create exercise sessions");
    const body = checkBody(rawBody, ["requestId"]);
    if (isReply(body)) return body;
    if (typeof body.requestId !== "string" || !UUID.test(body.requestId)) return fail(400, "INVALID_BODY", "requestId must be a UUID");
    const requestId = body.requestId;
    return deps.store.transaction(owner, async (tx) => {
      const existing = await tx.findSessionByRequest(owner, requestId);
      if (existing) return reply(200, await sessionDto(tx, existing));
      const session: SessionRow = { id: deps.uuid(), owner, requestId, scenarioVersion: SCENARIO_VERSION, createdAt: deps.now().toISOString() };
      await tx.insertSession(session, SCENARIOS.map((scenario) => ({ id: deps.uuid(), ord: scenario.order, scenarioId: scenario.id })));
      return reply(201, await sessionDto(tx, session));
    });
  }

  // GET /demo/sessions/{id}
  async function getSession(owner: string, role: string, sessionId: string): Promise<DemoReply> {
    if (role !== "operator") return fail(403, "FORBIDDEN_ROLE", "Only operator keys can read exercise sessions");
    if (!UUID.test(sessionId)) return fail(404, "NOT_FOUND", "Exercise session not found");
    return deps.store.transaction(null, async (tx) => {
      const session = await tx.getSession(sessionId);
      // Creator-only. Another operator's session is indistinguishable from a missing one.
      if (!session || session.owner !== owner) return fail(404, "NOT_FOUND", "Exercise session not found");
      return reply(200, await sessionDto(tx, session));
    });
  }

  // POST /demo/sessions/{id}/alerts/{alertId}/approve
  async function approve(owner: string, role: string, sessionId: string, alertId: string, rawBody: unknown): Promise<DemoReply> {
    if (role !== "operator") return fail(403, "FORBIDDEN_ROLE", "Only operator keys can approve exercise alerts");
    const body = checkBody(rawBody, ["requestId", "forecastHorizonHours", "predictionDigest", "callMessageHi", "callMessageEn"]);
    if (isReply(body)) return body;
    if (typeof body.requestId !== "string" || !UUID.test(body.requestId)) return fail(400, "INVALID_BODY", "requestId must be a UUID");
    if (body.forecastHorizonHours === undefined || body.forecastHorizonHours === null) return fail(400, "INVALID_BODY", "forecastHorizonHours is required");
    if (!isHorizon(body.forecastHorizonHours)) return fail(400, "UNSUPPORTED_HORIZON", `forecastHorizonHours must be one of ${HORIZONS.join(", ")}`, { supported: [...HORIZONS] });
    let digest: string | null = null;
    if (body.predictionDigest !== undefined && body.predictionDigest !== null) {
      if (typeof body.predictionDigest !== "string" || !DIGEST.test(body.predictionDigest)) return fail(400, "INVALID_BODY", "predictionDigest must be 64 lowercase hex characters");
      digest = body.predictionDigest;
    }
    if (!UUID.test(sessionId) || !UUID.test(alertId)) return fail(404, "NOT_FOUND", "Exercise session or alert not found");
    const horizon = body.forecastHorizonHours;
    const requestId = body.requestId;
    // The operator reviews this exact text on the page and the call speaks it (Hindi, then English). Bounded, control characters
    // removed. It can only ever go to the server-configured demo phone.
    const clean = (v: unknown) => (typeof v === "string" ? v.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, 900) : "");
    const spokenHi = clean(body.callMessageHi), spokenEn = clean(body.callMessageEn);
    const spoken = spokenHi ? `${spokenHi}${spokenEn ? ` ... ${spokenEn}` : ""}` : null;

    type Outcome =
      | { kind: "reply"; reply: DemoReply }
      | { kind: "done"; replayed: boolean; row: AlertRow; allowance: Allowance; reserved: boolean };

    const first = await deps.store.transaction<Outcome>(owner, async (tx) => {
      const session = await tx.getSession(sessionId);
      if (!session || session.owner !== owner) return { kind: "reply", reply: fail(404, "NOT_FOUND", "Exercise session or alert not found") };
      const row = await tx.getAlertForUpdate(sessionId, alertId);
      if (!row) return { kind: "reply", reply: fail(404, "NOT_FOUND", "Exercise session or alert not found") };

      // 1. Prior approval first: duplicates never reach the limit checks and never call again.
      if (row.approvalStatus === "approved") {
        if (row.horizonHours !== horizon || row.predictionDigest !== digest) {
          return { kind: "reply", reply: fail(409, "ALREADY_APPROVED", "This alert was already approved with a different horizon or prediction digest. Approved references are immutable.") };
        }
        return { kind: "done", replayed: true, row, allowance: await allowance(tx, owner, sessionId), reserved: false };
      }

      // 2. Limits. A rejection returns without writing anything, so approval stays pending.
      const now = deps.now();
      if ((await tx.ledgerCountSession(sessionId)) >= SESSION_CALLS_MAX) {
        return { kind: "reply", reply: fail(429, "ALLOWANCE_EXHAUSTED", `This session has used all ${SESSION_CALLS_MAX} exercise calls.`, { scope: "session" }) };
      }
      if ((await tx.ledgerCountOwnerSince(owner, new Date(now.getTime() - 24 * 3600_000).toISOString())) >= OPERATOR_CALLS_PER_24H) {
        return { kind: "reply", reply: fail(429, "ALLOWANCE_EXHAUSTED", `This operator has used all ${OPERATOR_CALLS_PER_24H} exercise calls in the last 24 hours.`, { scope: "operator_24h" }, { "Retry-After": "3600" }) };
      }
      const last = await tx.ledgerLastOwner(owner);
      if (last) {
        const wait = Math.ceil((Date.parse(last) + COOLDOWN_SECONDS * 1000 - now.getTime()) / 1000);
        if (wait > 0) return { kind: "reply", reply: fail(429, "COOLDOWN", `Another exercise call was placed moments ago. Wait ${wait} s.`, { retryAfterSeconds: wait }, { "Retry-After": String(wait) }) };
      }

      // 3. Persist approval + frozen reference + reservation + ledger atomically (before any provider contact).
      const config = deps.config();
      const reserve = Boolean(config.alertPhone) && config.provider === "omnidimension";
      const scenario = findScenario(row.scenarioId)!;
      const nowIso = now.toISOString();
      const change: ApplyApproval = {
        approvedAt: nowIso,
        approvedBy: owner,
        requestId,
        horizonHours: horizon,
        predictionDigest: digest,
        predictionRef: predictionReference(scenario, horizon, digest),
        callStatus: reserve ? "dispatching" : "not_configured",
        reserve,
      };
      await tx.applyApproval(row, owner, sessionId, change);
      const updated = (await tx.getAlertForUpdate(sessionId, alertId))!;
      return { kind: "done", replayed: false, row: updated, allowance: await allowance(tx, owner, sessionId), reserved: reserve };
    });

    if (first.kind === "reply") return first.reply;
    let row = first.row;

    // 4. Contact the provider only for the request that won the reservation.
    if (first.reserved) {
      const scenario = findScenario(row.scenarioId)!;
      const config = deps.config();
      let status: CallStatus = "unknown";
      let providerRef: string | null = null;
      try {
        const result = await deps.dispatch(
          "omnidimension",
          "call",
          { id: null, name: "Demo phone", phone: config.alertPhone! }, // server-configured destination only
          spoken ?? messageHi(scenario),
          {
            place: `${scenario.villageName}, ${scenario.district}`,
            title: alertTitle(scenario),
            source: "JalNetra exercise on replayed 2026 data (not a real warning)",
            observed: "Exercise",
            safe_place: "nearest school or panchayat building on high ground (exercise)",
          },
          `demo-${row.id}`,
          { timeoutMs: PROVIDER_TIMEOUT_MS },
        );
        status = result.status === "sent" ? "dispatched" : result.status === "failed" ? "failed" : result.status === "not_configured" ? "not_configured" : "unknown";
        providerRef = result.providerRef;
      } catch (error) {
        log("demo dispatch threw", String(error));
        status = "unknown";
      }
      log("demo exercise call", { alert: row.id, status });
      const atIso = deps.now().toISOString();
      try {
        const updated = await deps.store.transaction(owner, (tx) => tx.setOutcome(row.id, status, providerRef, atIso));
        if (updated) row = { ...row, callStatus: status, callUpdatedAt: atIso };
      } catch (error) {
        // The call attempt is already reserved and will not be repeated. Reads report "unknown" once the row goes stale.
        log("demo outcome write failed", String(error));
        row = { ...row, callStatus: "unknown", callUpdatedAt: atIso };
      }
    }

    const result: DemoApprovalResult = { replayed: first.replayed, alert: toAlert(row, true), session: { allowance: first.allowance } };
    return reply(200, result);
  }

  // GET /demo/public/{id}  (anonymous)
  async function publicFeed(sessionId: string): Promise<DemoReply> {
    const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
    if (!UUID.test(sessionId)) return fail(404, "NOT_FOUND", "Exercise session not found", undefined, headers);
    return deps.store.transaction(null, async (tx) => {
      const session = await tx.getSession(sessionId);
      if (!session) return fail(404, "NOT_FOUND", "Exercise session not found", undefined, headers);
      const rows = (await tx.getAlerts(sessionId)).filter((row) => row.approvalStatus === "approved" && row.approvedAt && row.predictionRef);
      const feed: PublicDemoFeed = {
        exercise: true,
        banner: PUBLIC_BANNER,
        sessionId,
        generatedAt: deps.now().toISOString(),
        items: rows.map((row) => {
          const alert = toAlert(row, false);
          return {
            id: alert.id,
            order: alert.order,
            title: alert.title,
            messageHi: alert.messageHi,
            messageEn: alert.messageEn,
            prediction: alert.prediction,
            approvedAt: row.approvedAt!,
            demoCall: alert.callStatus === "dispatched" ? ("dispatched" as const) : ("not_confirmed" as const),
          };
        }),
      };
      return reply(200, feed, headers);
    });
  }

  return { createSession, getSession, approve, publicFeed };
}

// ---- Postgres store ----
type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };
export type PgTransactionRunner = <T>(work: (client: Queryable) => Promise<T>) => Promise<T>;

const iso = (value: unknown): string | null => (value == null ? null : value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString());
const sessionFrom = (r: any): SessionRow => ({ id: r.id, owner: r.owner, requestId: r.request_id, scenarioVersion: r.scenario_version, createdAt: iso(r.created_at)! });
const alertFrom = (r: any): AlertRow => ({
  id: r.id,
  sessionId: r.session_id,
  ord: Number(r.ord),
  scenarioId: r.scenario_id,
  approvalStatus: r.approval_status,
  approvedAt: iso(r.approved_at),
  approvedBy: r.approved_by ?? null,
  approveRequestId: r.approve_request_id ?? null,
  horizonHours: r.horizon_hours == null ? null : Number(r.horizon_hours),
  predictionDigest: r.prediction_digest ?? null,
  predictionRef: r.prediction_ref == null ? null : typeof r.prediction_ref === "string" ? JSON.parse(r.prediction_ref) : r.prediction_ref,
  callStatus: r.call_status,
  callAttempts: Number(r.call_attempts),
  callUpdatedAt: iso(r.call_updated_at),
});

export function createPgStore(run: PgTransactionRunner): DemoStore {
  return {
    transaction: (owner, work) =>
      run(async (client) => {
        if (owner) {
          // Per-operator mutex: serialises that operator's approvals/creates across Lambda instances.
          await client.query("INSERT INTO jn_demo_operators (owner) VALUES ($1) ON CONFLICT (owner) DO NOTHING", [owner]);
          await client.query("SELECT owner FROM jn_demo_operators WHERE owner = $1 FOR UPDATE", [owner]);
        }
        const tx: DemoTx = {
          async getSession(id) {
            const r = await client.query("SELECT id, owner, request_id, scenario_version, created_at FROM jn_demo_sessions WHERE id = $1", [id]);
            return r.rows[0] ? sessionFrom(r.rows[0]) : null;
          },
          async findSessionByRequest(ownerName, requestId) {
            const r = await client.query("SELECT id, owner, request_id, scenario_version, created_at FROM jn_demo_sessions WHERE owner = $1 AND request_id = $2", [ownerName, requestId]);
            return r.rows[0] ? sessionFrom(r.rows[0]) : null;
          },
          async insertSession(session, alerts) {
            await client.query("INSERT INTO jn_demo_sessions (id, owner, request_id, scenario_version, created_at) VALUES ($1, $2, $3, $4, $5)", [session.id, session.owner, session.requestId, session.scenarioVersion, session.createdAt]);
            for (const alert of alerts) {
              await client.query("INSERT INTO jn_demo_alerts (id, session_id, ord, scenario_id) VALUES ($1, $2, $3, $4)", [alert.id, session.id, alert.ord, alert.scenarioId]);
            }
          },
          async getAlerts(sessionId) {
            const r = await client.query("SELECT * FROM jn_demo_alerts WHERE session_id = $1 ORDER BY ord", [sessionId]);
            return r.rows.map(alertFrom);
          },
          async getAlertForUpdate(sessionId, alertId) {
            const r = await client.query("SELECT * FROM jn_demo_alerts WHERE session_id = $1 AND id = $2 FOR UPDATE", [sessionId, alertId]);
            return r.rows[0] ? alertFrom(r.rows[0]) : null;
          },
          async ledgerCountSession(sessionId) {
            const r = await client.query("SELECT count(*) AS n FROM jn_demo_call_ledger WHERE session_id = $1", [sessionId]);
            return Number(r.rows[0].n);
          },
          async ledgerCountOwnerSince(ownerName, sinceIso) {
            const r = await client.query("SELECT count(*) AS n FROM jn_demo_call_ledger WHERE owner = $1 AND reserved_at >= $2", [ownerName, sinceIso]);
            return Number(r.rows[0].n);
          },
          async ledgerLastOwner(ownerName) {
            const r = await client.query("SELECT reserved_at FROM jn_demo_call_ledger WHERE owner = $1 ORDER BY reserved_at DESC LIMIT 1", [ownerName]);
            return r.rows[0] ? iso(r.rows[0].reserved_at) : null;
          },
          async applyApproval(alert, ownerName, sessionId, change) {
            const updated = await client.query(
              `UPDATE jn_demo_alerts SET approval_status = 'approved', approved_at = $2, approved_by = $3, approve_request_id = $4,
                 horizon_hours = $5, prediction_digest = $6, prediction_ref = $7, call_status = $8, call_attempts = $9, call_updated_at = $2
               WHERE id = $1 AND approval_status = 'pending'`,
              [alert.id, change.approvedAt, change.approvedBy, change.requestId, change.horizonHours, change.predictionDigest, JSON.stringify(change.predictionRef), change.callStatus, change.reserve ? 1 : 0],
            );
            if (updated.rowCount !== 1) throw new Error("Alert was not pending");
            if (change.reserve) {
              await client.query("INSERT INTO jn_demo_call_ledger (owner, session_id, alert_id, reserved_at) VALUES ($1, $2, $3, $4)", [ownerName, sessionId, alert.id, change.approvedAt]);
            }
          },
          async setOutcome(alertId, status, providerRef, atIso) {
            const r = await client.query("UPDATE jn_demo_alerts SET call_status = $2, provider_ref = $3, call_updated_at = $4 WHERE id = $1 AND call_status = 'dispatching'", [alertId, status, providerRef, atIso]);
            return r.rowCount === 1;
          },
        };
        return work(tx);
      }),
  };
}

export function createDefaultDemoApi() {
  return createDemoApi({
    store: createPgStore((work) => transaction((client) => work(client as unknown as Queryable))),
    dispatch: dispatchAlert,
    config: () => ({ alertPhone: telephonyConfig().alertPhone, provider: selectedProvider("call") }),
    now: () => new Date(),
    uuid: randomUUID,
    log: (message, data) => console.log("JalNetra", message, data ?? ""),
  });
}

let defaultApi: ReturnType<typeof createDefaultDemoApi> | undefined;
const api = () => (defaultApi ??= createDefaultDemoApi());

/** Public, anonymous route. Returns null when the path is not a demo-public path. */
export async function routeDemoPublic(method: string, path: string): Promise<DemoReply | null> {
  const match = path.match(/^\/demo\/public\/([^/]+)$/);
  if (!match || method !== "GET") return null;
  try {
    return await api().publicFeed(match[1]);
  } catch (error) {
    console.error("JalNetra demo public feed failed", error);
    return fail(500, "INTERNAL", "Demo feed unavailable", undefined, { "Cache-Control": "no-store" });
  }
}

/** Authenticated routes. Returns null when the path/method is not a demo route so the caller can 404. */
export async function routeDemo(method: string, path: string, who: { owner: string; role: string }, body: unknown): Promise<DemoReply | null> {
  try {
    if (method === "POST" && path === "/demo/sessions") return await api().createSession(who.owner, who.role, body);
    const session = path.match(/^\/demo\/sessions\/([^/]+)$/);
    if (method === "GET" && session) return await api().getSession(who.owner, who.role, session[1]);
    const approveMatch = path.match(/^\/demo\/sessions\/([^/]+)\/alerts\/([^/]+)\/approve$/);
    if (method === "POST" && approveMatch) return await api().approve(who.owner, who.role, approveMatch[1], approveMatch[2], body);
    return null;
  } catch (error) {
    console.error("JalNetra demo request failed", error);
    return fail(500, "INTERNAL", "Internal server error");
  }
}
