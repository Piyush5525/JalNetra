// Focused tests for the Conduct Demo backend. Real SQL (the migration section of schema.sql) runs on
// pg-mem. The provider and clock are mocked: nothing here calls OmniDimension, Twilio or AWS.
//
// pg-mem is single-process and ignores row locks, so the harness serialises transactions with a mutex to
// stand in for the per-operator `SELECT ... FOR UPDATE` that real Postgres provides. The database-level
// backstops (UNIQUE ledger row per alert, "pending only" UPDATE) are asserted separately.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { newDb } from "pg-mem";
import {
  COOLDOWN_SECONDS,
  OPERATOR_CALLS_PER_24H,
  PROVIDER_TIMEOUT_MS,
  SESSION_CALLS_MAX,
  createDemoApi,
  createPgStore,
  type DemoApprovalResult,
  type DemoSession,
  type PublicDemoFeed,
} from "../src/demo.js";
import { SCENARIOS } from "../src/demoScenarios.js";
import { dispatchAlert } from "../src/telephony.js";

const SCHEMA = readFileSync(new URL("../../schema.sql", import.meta.url), "utf8");
const DEMO_SQL = SCHEMA.slice(SCHEMA.indexOf("-- ===== Conduct Demo"));
const PHONE = "+919999900412";
const T0 = Date.parse("2026-10-11T08:00:00Z");

type DispatchResult = { status: "sent" | "failed" | "not_configured" | "unknown"; providerRef: string | null; error: string | null };
type Call = { provider: string; channel: string; target: { id: string | null; name: string; phone: string }; message: string; context: Record<string, string>; incidentId: string; options: { timeoutMs?: number } | undefined };

function setup(opts: { alertPhone?: string | undefined; provider?: "omnidimension" | "twilio" | "not_configured"; result?: () => Promise<DispatchResult> } = {}) {
  const db = newDb();
  db.public.none(DEMO_SQL);
  const { Pool } = db.adapters.createPg();
  const pool = new Pool();
  const sql: string[] = [];
  let chain: Promise<unknown> = Promise.resolve();
  const run = <T>(work: (client: { query: (text: string, values?: unknown[]) => Promise<any> }) => Promise<T>): Promise<T> => {
    const job = chain.then(async () => {
      const client = await pool.connect();
      const spy = { query: (text: string, values?: unknown[]) => { sql.push(text); return client.query(text, values); } };
      try {
        await client.query("BEGIN");
        const out = await work(spy);
        await client.query("COMMIT");
        return out;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    });
    chain = job.catch(() => undefined);
    return job;
  };
  const clock = { t: T0 };
  const calls: Call[] = [];
  const config = { alertPhone: "alertPhone" in opts ? opts.alertPhone : PHONE, provider: opts.provider ?? ("omnidimension" as const) };
  const behaviour = { result: opts.result ?? (async (): Promise<DispatchResult> => ({ status: "sent", providerRef: "ref-1", error: null })) };
  const dispatch = (async (provider: string, channel: string, target: Call["target"], message: string, context: Call["context"], incidentId: string, options?: Call["options"]) => {
    calls.push({ provider, channel, target, message, context, incidentId, options });
    return behaviour.result();
  }) as unknown as typeof dispatchAlert;
  const api = createDemoApi({ store: createPgStore(run), dispatch, config: () => config, now: () => new Date(clock.t), uuid: randomUUID });
  return { api, calls, clock, sql, config, behaviour, pool };
}

type Env = ReturnType<typeof setup>;
const create = async (env: Env, owner = "ops-lead", role = "operator") => {
  const r = await env.api.createSession(owner, role, { requestId: randomUUID() });
  return { r, session: r.body as DemoSession };
};
const approve = (env: Env, session: DemoSession, index: number, owner = "ops-lead", body: Record<string, unknown> = {}) =>
  env.api.approve(owner, "operator", session.id, session.alerts[index].id, { requestId: randomUUID(), forecastHorizonHours: 6, ...body });

test("non-operator mutations are rejected and write nothing", async () => {
  const env = setup();
  const denied = await env.api.createSession("rep", "reporter", { requestId: randomUUID() });
  assert.equal(denied.status, 403);
  assert.equal((denied.body as any).code, "FORBIDDEN_ROLE");
  const { session } = await create(env);
  const r = await env.api.approve("rep", "reporter", session.id, session.alerts[0].id, { requestId: randomUUID(), forecastHorizonHours: 6 });
  assert.equal(r.status, 403);
  assert.equal(env.calls.length, 0);
  assert.equal((await env.api.getSession("rep", "reporter", session.id)).status, 403);
});

test("a new session has exactly five pending alerts and never calls the provider", async () => {
  const env = setup();
  const { r, session } = await create(env);
  assert.equal(r.status, 201);
  assert.equal(session.alerts.length, 5);
  assert.deepEqual(session.alerts.map((a) => a.order), [1, 2, 3, 4, 5]);
  assert.deepEqual(session.alerts.map((a) => a.prediction.scenarioId), SCENARIOS.map((s) => s.id));
  assert.equal(session.alerts[0].prediction.villageName, "Harpur");
  for (const alert of session.alerts) {
    assert.equal(alert.approvalStatus, "pending");
    assert.equal(alert.callStatus, "not_requested");
    assert.equal(alert.callAttempts, 0);
    assert.equal(alert.prediction.horizonHours, null);
    assert.equal(alert.prediction.dataBasis, "synthetic_replay");
    assert.ok(alert.messageHi.startsWith("यह एक अभ्यास संदेश है"));
    assert.ok(alert.messageEn.startsWith("EXERCISE ONLY"));
  }
  assert.deepEqual(session.demoDestination, { configured: true, masked: "+91******0412", provider: "omnidimension" });
  assert.equal(session.allowance.callsMax, SESSION_CALLS_MAX);
  await env.api.getSession("ops-lead", "operator", session.id);
  await env.api.publicFeed(session.id);
  assert.equal(env.calls.length, 0, "create/read/public must never reach the provider");
  assert.ok(!JSON.stringify(session).includes(PHONE), "full phone number must never be returned");
});

test("session creation is retry-safe on requestId", async () => {
  const env = setup();
  const requestId = randomUUID();
  const a = await env.api.createSession("ops-lead", "operator", { requestId });
  const b = await env.api.createSession("ops-lead", "operator", { requestId });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal((a.body as DemoSession).id, (b.body as DemoSession).id);
  assert.equal((b.body as DemoSession).alerts.length, 5);
  const c = await env.api.createSession("ops-lead", "operator", { requestId: randomUUID() });
  assert.notEqual((c.body as DemoSession).id, (a.body as DemoSession).id);
  const bad = await env.api.createSession("ops-lead", "operator", { requestId: "not-a-uuid" });
  assert.equal(bad.status, 400);
});

test("sessions are creator-only for operator reads and approvals", async () => {
  const env = setup();
  const { session } = await create(env, "alice");
  assert.equal((await env.api.getSession("bob", "operator", session.id)).status, 404);
  const r = await env.api.approve("bob", "operator", session.id, session.alerts[0].id, { requestId: randomUUID(), forecastHorizonHours: 6 });
  assert.equal(r.status, 404);
  assert.equal(env.calls.length, 0);
  assert.equal((await env.api.getSession("alice", "operator", session.id)).status, 200);
});

test("invalid session, alert and horizon are rejected before any call", async () => {
  const env = setup();
  const { session } = await create(env);
  const other = (await create(env)).session;
  const ok = { requestId: randomUUID(), forecastHorizonHours: 6 };
  assert.equal((await env.api.approve("ops-lead", "operator", "nope", session.alerts[0].id, ok)).status, 404);
  assert.equal((await env.api.approve("ops-lead", "operator", randomUUID(), session.alerts[0].id, ok)).status, 404);
  assert.equal((await env.api.approve("ops-lead", "operator", session.id, randomUUID(), ok)).status, 404);
  assert.equal((await env.api.approve("ops-lead", "operator", session.id, other.alerts[0].id, ok)).status, 404, "alert from another session");
  for (const horizon of [1, 5, 48, -3, "6", 6.5]) {
    const r = await env.api.approve("ops-lead", "operator", session.id, session.alerts[0].id, { requestId: randomUUID(), forecastHorizonHours: horizon });
    assert.equal(r.status, 400);
    assert.equal((r.body as any).code, "UNSUPPORTED_HORIZON");
  }
  assert.equal((await env.api.approve("ops-lead", "operator", session.id, session.alerts[0].id, { requestId: randomUUID() })).status, 400);
  assert.equal((await env.api.approve("ops-lead", "operator", session.id, session.alerts[0].id, { requestId: "x", forecastHorizonHours: 6 })).status, 400);
  assert.equal((await env.api.approve("ops-lead", "operator", session.id, session.alerts[0].id, { ...ok, predictionDigest: "short" })).status, 400);
  assert.equal(env.calls.length, 0);
  const after = (await env.api.getSession("ops-lead", "operator", session.id)).body as DemoSession;
  assert.ok(after.alerts.every((a) => a.approvalStatus === "pending"));
});

test("real recipients and message text cannot be injected", async () => {
  const env = setup();
  const { session } = await create(env);
  for (const field of ["phone", "to", "contact_ids", "contactIds", "contacts", "channel", "message", "demo", "sms"]) {
    const r = await approve(env, session, 0, "ops-lead", { [field]: field === "contactIds" || field === "contact_ids" || field === "contacts" ? ["00000000-0000-4000-8000-000000000000"] : "+911234567890" });
    assert.equal(r.status, 400, field);
    assert.equal((r.body as any).code, "FIELD_NOT_ALLOWED", field);
  }
  assert.equal((await env.api.createSession("ops-lead", "operator", { requestId: randomUUID(), phone: "+911234567890" })).status, 400);
  assert.equal(env.calls.length, 0);
  const ok = await approve(env, session, 0);
  assert.equal(ok.status, 200);
  assert.equal(env.calls.length, 1);
  const call = env.calls[0];
  assert.equal(call.provider, "omnidimension");
  assert.equal(call.channel, "call");
  assert.equal(call.target.phone, PHONE, "destination is the server-configured demo phone");
  assert.equal(call.target.id, null, "no contact id");
  assert.ok(call.message.startsWith("यह एक अभ्यास संदेश है"), "exercise notice is part of the spoken message");
  assert.equal(call.options?.timeoutMs, PROVIDER_TIMEOUT_MS);
});

test("missing configuration is reported and no call is attempted", async () => {
  for (const cfg of [{ alertPhone: undefined }, { provider: "twilio" as const }, { provider: "not_configured" as const }]) {
    const env = setup(cfg);
    const { session } = await create(env);
    if (!("provider" in cfg)) assert.equal(session.demoDestination.configured, false);
    const r = await approve(env, session, 0);
    const result = r.body as DemoApprovalResult;
    assert.equal(r.status, 200);
    assert.equal(result.alert.approvalStatus, "approved");
    assert.equal(result.alert.callStatus, "not_configured");
    assert.equal(result.alert.callAttempts, 0);
    assert.equal(result.session.allowance.callsUsed, 0, "an unconfigured attempt does not consume allowance");
    assert.equal(env.calls.length, 0);
  }
});

test("approval persists approval, frozen reference, reservation and ledger before the provider is contacted", async () => {
  const env = setup();
  const { session } = await create(env);
  let during: DemoSession | undefined;
  env.behaviour.result = async () => {
    during = (await env.api.getSession("ops-lead", "operator", session.id)).body as DemoSession;
    return { status: "sent", providerRef: "r", error: null };
  };
  const digest = "a".repeat(64);
  const r = await approve(env, session, 0, "ops-lead", { predictionDigest: digest });
  const alert = during!.alerts[0];
  assert.equal(alert.approvalStatus, "approved");
  assert.equal(alert.callStatus, "dispatching");
  assert.equal(alert.callAttempts, 1);
  assert.equal(alert.prediction.horizonHours, 6);
  assert.equal(alert.prediction.predictionDigest, digest);
  assert.equal(during!.allowance.callsUsed, 1);
  const done = (r.body as DemoApprovalResult).alert;
  assert.equal(done.callStatus, "dispatched");
  assert.equal(done.callNote, "Dispatch is not confirmation it was answered.");
  assert.equal(done.prediction.horizonHours, 6);
});

test("repeated and concurrent approvals produce at most one provider attempt", async () => {
  const env = setup();
  const { session } = await create(env);
  const results = await Promise.all([0, 1, 2, 3, 4, 5].map(() => approve(env, session, 0)));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(env.calls.length, 1);
  assert.equal(results.filter((r) => (r.body as DemoApprovalResult).replayed === false).length, 1);
  const again = await approve(env, session, 0);
  assert.equal((again.body as DemoApprovalResult).replayed, true);
  assert.equal((again.body as DemoApprovalResult).alert.callStatus, "dispatched");
  assert.equal(env.calls.length, 1);
  // a second tab (new requestId) and a replay after the cooldown are also stored-outcome replays
  env.clock.t += 120_000;
  const later = await approve(env, session, 0);
  assert.equal((later.body as DemoApprovalResult).replayed, true);
  assert.equal(env.calls.length, 1);
});

test("a different horizon or digest after approval is a conflict and does not call", async () => {
  const env = setup();
  const { session } = await create(env);
  const digest = "b".repeat(64);
  await approve(env, session, 0, "ops-lead", { predictionDigest: digest });
  for (const body of [{ forecastHorizonHours: 12, predictionDigest: digest }, { forecastHorizonHours: 6, predictionDigest: "c".repeat(64) }, { forecastHorizonHours: 6 }]) {
    const r = await approve(env, session, 0, "ops-lead", body);
    assert.equal(r.status, 409);
    assert.equal((r.body as any).code, "ALREADY_APPROVED");
  }
  assert.equal((await approve(env, session, 0, "ops-lead", { predictionDigest: digest })).status, 200);
  assert.equal(env.calls.length, 1);
  // approved without a digest: sending one later is also a conflict
  env.clock.t += 60_000;
  await approve(env, session, 1);
  assert.equal((await approve(env, session, 1, "ops-lead", { predictionDigest: digest })).status, 409);
});

test("provider failure, throw and timeout never report success and are never retried", async () => {
  const cases: Array<[string, () => Promise<DispatchResult>, string]> = [
    ["provider rejected", async () => ({ status: "failed", providerRef: null, error: "bad agent" }), "failed"],
    ["provider timeout / network error", async () => ({ status: "unknown", providerRef: null, error: "AbortError" }), "unknown"],
    ["dispatch threw", async () => { throw new Error("socket hang up"); }, "unknown"],
    ["provider says not configured", async () => ({ status: "not_configured", providerRef: null, error: null }), "not_configured"],
  ];
  for (const [label, result, expected] of cases) {
    const env = setup({ result });
    const { session } = await create(env);
    const r = await approve(env, session, 0);
    const alert = (r.body as DemoApprovalResult).alert;
    assert.equal(alert.approvalStatus, "approved", label);
    assert.equal(alert.callStatus, expected, label);
    assert.equal(alert.callAttempts, 1, label);
    assert.notEqual(alert.callStatus, "dispatched", label);
    env.clock.t += 600_000;
    const again = await approve(env, session, 0);
    assert.equal((again.body as DemoApprovalResult).replayed, true, label);
    assert.equal((again.body as DemoApprovalResult).alert.callStatus, expected, label);
    assert.equal(env.calls.length, 1, `${label}: no automatic or manual retry`);
    const stored = ((await env.api.getSession("ops-lead", "operator", session.id)).body as DemoSession).alerts[0];
    assert.equal(stored.callStatus, expected, label);
    if (expected === "unknown") assert.match(stored.callNote ?? "", /may or may not/);
  }
});

test("a call stuck in dispatching reads as unknown after 60 s", async () => {
  const env = setup();
  const { session } = await create(env);
  let release: (r: DispatchResult) => void = () => undefined;
  env.behaviour.result = () => new Promise<DispatchResult>((resolve) => { release = resolve; });
  const pending = approve(env, session, 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const duplicate = await approve(env, session, 0);
  assert.equal((duplicate.body as DemoApprovalResult).replayed, true);
  assert.equal((duplicate.body as DemoApprovalResult).alert.callStatus, "dispatching");
  env.clock.t += 61_000;
  const stale = ((await env.api.getSession("ops-lead", "operator", session.id)).body as DemoSession).alerts[0];
  assert.equal(stale.callStatus, "unknown");
  release({ status: "sent", providerRef: "late", error: null });
  await pending;
  assert.equal(env.calls.length, 1);
});

test("cooldown rejection leaves approval unchanged; later it succeeds", async () => {
  const env = setup();
  const { session } = await create(env);
  assert.equal((await approve(env, session, 0)).status, 200);
  env.clock.t += 10_000;
  const blocked = await approve(env, session, 1);
  assert.equal(blocked.status, 429);
  assert.equal((blocked.body as any).code, "COOLDOWN");
  assert.equal((blocked.body as any).details.retryAfterSeconds, COOLDOWN_SECONDS - 10);
  assert.equal(blocked.headers?.["Retry-After"], String(COOLDOWN_SECONDS - 10));
  const state = ((await env.api.getSession("ops-lead", "operator", session.id)).body as DemoSession);
  assert.equal(state.alerts[1].approvalStatus, "pending", "a rejected approval must leave the alert pending");
  assert.equal(state.alerts[1].callStatus, "not_requested");
  assert.equal(state.allowance.callsUsed, 1);
  assert.ok(state.allowance.nextCallAllowedAt);
  assert.equal(env.calls.length, 1);
  env.clock.t += 21_000;
  assert.equal((await approve(env, session, 1)).status, 200);
  assert.equal(env.calls.length, 2);
});

test("session allowance of 3 calls and operator allowance of 10 per rolling 24 h", async () => {
  const env = setup();
  const { session } = await create(env);
  for (let i = 0; i < SESSION_CALLS_MAX; i++) {
    assert.equal((await approve(env, session, i)).status, 200);
    env.clock.t += (COOLDOWN_SECONDS + 1) * 1000;
  }
  const fourth = await approve(env, session, 3);
  assert.equal(fourth.status, 429);
  assert.equal((fourth.body as any).code, "ALLOWANCE_EXHAUSTED");
  assert.equal(((await env.api.getSession("ops-lead", "operator", session.id)).body as DemoSession).alerts[3].approvalStatus, "pending");
  assert.equal(env.calls.length, 3);

  // operator-level limit across sessions: 3 used so far, 7 more allowed
  let used = 3;
  while (used < OPERATOR_CALLS_PER_24H) {
    const s = (await create(env)).session;
    for (let i = 0; i < SESSION_CALLS_MAX && used < OPERATOR_CALLS_PER_24H; i++, used++) {
      assert.equal((await approve(env, s, i)).status, 200);
      env.clock.t += (COOLDOWN_SECONDS + 1) * 1000;
    }
  }
  assert.equal(env.calls.length, OPERATOR_CALLS_PER_24H);
  const extra = (await create(env)).session;
  const blocked = await approve(env, extra, 0);
  assert.equal(blocked.status, 429);
  assert.equal((blocked.body as any).details.scope, "operator_24h");
  assert.equal(env.calls.length, OPERATOR_CALLS_PER_24H);
  // another operator is unaffected
  const bob = (await create(env, "bob")).session;
  assert.equal((await approve(env, bob, 0, "bob")).status, 200);
  // the window rolls
  env.clock.t += 25 * 3600_000;
  assert.equal((await approve(env, extra, 0)).status, 200);
});

test("the public feed shows only approved exercise alerts and no private fields", async () => {
  const env = setup();
  const { session } = await create(env, "secret-owner-label");
  const empty = await env.api.publicFeed(session.id);
  assert.equal(empty.status, 200);
  assert.deepEqual((empty.body as PublicDemoFeed).items, []);
  assert.equal((empty.body as PublicDemoFeed).exercise, true);
  assert.equal((empty.body as PublicDemoFeed).banner, "EXERCISE / अभ्यास: not a real flood warning");
  assert.equal(empty.headers?.["Cache-Control"], "no-store");

  await approve(env, session, 0, "secret-owner-label", { predictionDigest: "d".repeat(64) });
  const feed = await env.api.publicFeed(session.id);
  const body = feed.body as PublicDemoFeed;
  assert.equal(body.items.length, 1, "pending alerts are not published");
  const item = body.items[0];
  assert.equal(item.prediction.villageName, "Harpur");
  assert.equal(item.prediction.horizonHours, 6);
  assert.equal(item.prediction.dataBasis, "synthetic_replay");
  assert.equal(item.demoCall, "dispatched");
  const text = JSON.stringify(body);
  for (const secret of [PHONE, "9999900412", "secret-owner-label", "ref-1", "providerRef", "provider_ref", "transcript", "approvedBy", "createdBy", "requestId", "demoDestination", "allowance", "callStatus", "contact"]) {
    assert.ok(!text.includes(secret), `public feed leaked ${secret}`);
  }
  assert.equal((await env.api.publicFeed(randomUUID())).status, 404);
  assert.equal((await env.api.publicFeed("not-a-uuid")).status, 404);

  // an unconfirmed call is not presented as placed
  env.behaviour.result = async () => ({ status: "unknown", providerRef: null, error: "timeout" });
  env.clock.t += 60_000;
  assert.equal((await approve(env, session, 1, "secret-owner-label")).status, 200);
  const second = (await env.api.publicFeed(session.id)).body as PublicDemoFeed;
  assert.equal(second.items.length, 2);
  assert.equal(second.items[1].demoCall, "not_confirmed");
});

test("demo operations touch only jn_demo_* tables, so real incidents are unaffected", async () => {
  const env = setup();
  const { session } = await create(env);
  await approve(env, session, 0);
  await env.api.getSession("ops-lead", "operator", session.id);
  await env.api.publicFeed(session.id);
  assert.ok(env.sql.length > 10);
  for (const statement of env.sql) {
    assert.ok(!/\bjn_(incidents|alerts|contacts|events|api_keys|config)\b/.test(statement), `touches a real table: ${statement}`);
  }
});

test("database backstops: one ledger row per alert and approval only from pending", async () => {
  const env = setup();
  const { session } = await create(env);
  await approve(env, session, 0);
  const client = await env.pool.connect();
  await assert.rejects(client.query("INSERT INTO jn_demo_call_ledger (owner, session_id, alert_id) VALUES ($1, $2, $3)", ["ops-lead", session.id, session.alerts[0].id]));
  const again = await client.query("UPDATE jn_demo_alerts SET approval_status = 'approved' WHERE id = $1 AND approval_status = 'pending'", [session.alerts[0].id]);
  assert.equal(again.rowCount, 0);
  client.release();
});
