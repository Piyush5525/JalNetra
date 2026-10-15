// dispatchAlert tests with a mocked fetch. Credentials below are throwaway test values, not real ones.
// Proves (a) the new optional timeout is opt-in and (b) existing callers keep their behaviour.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, test } from "node:test";
import { dispatchAlert } from "../src/telephony.js";

const realFetch = globalThis.fetch;
const target = { id: null, name: "Demo phone", phone: "+910000000000" };
const ctx = { place: "x" };
let seen: { url: string; signal?: AbortSignal }[] = [];

beforeEach(() => {
  seen = [];
  process.env.OMNIDIM_KEY = "test-key";
  process.env.OMNIDIM_AGENT = "7";
});
afterEach(() => {
  globalThis.fetch = realFetch;
});
const mockFetch = (impl: (signal?: AbortSignal) => Promise<Response>) => {
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), signal: init?.signal ?? undefined });
    return impl(init?.signal ?? undefined);
  }) as typeof fetch;
};
const respond = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });
const hang = (signal?: AbortSignal) => new Promise<Response>((_, reject) => signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

test("default mode (existing callers) is unchanged: no signal, errors and 5xx are 'failed'", async () => {
  mockFetch(respond(200, { success: true, requestId: "r1" }));
  assert.deepEqual(await dispatchAlert("omnidimension", "call", target, "m", ctx, "i"), { status: "sent", providerRef: "r1", error: null });
  assert.equal(seen[0].signal, undefined, "no AbortSignal unless a timeout is requested");

  mockFetch(respond(500, { message: "boom" }));
  assert.equal((await dispatchAlert("omnidimension", "call", target, "m", ctx, "i")).status, "failed");

  mockFetch(respond(400, { message: "bad" }));
  assert.equal((await dispatchAlert("omnidimension", "call", target, "m", ctx, "i")).status, "failed");

  mockFetch(async () => { throw new Error("network down"); });
  assert.equal((await dispatchAlert("omnidimension", "call", target, "m", ctx, "i")).status, "failed");

  mockFetch(respond(200, { success: false, message: "refused" }));
  assert.equal((await dispatchAlert("omnidimension", "call", target, "m", ctx, "i")).status, "failed");

  assert.equal((await dispatchAlert("not_configured", "call", target, "m", ctx, "i")).status, "not_configured");
});

test("timeout mode: 2xx sent, 4xx failed, 5xx / network error / abort are unknown", async () => {
  const opts = { timeoutMs: 40 };
  mockFetch(respond(200, { success: true, requestId: "r2" }));
  assert.equal((await dispatchAlert("omnidimension", "call", target, "m", ctx, "i", opts)).status, "sent");
  assert.ok(seen[0].signal, "AbortSignal is passed in timeout mode");

  mockFetch(respond(401, { message: "unauthorised" }));
  assert.equal((await dispatchAlert("omnidimension", "call", target, "m", ctx, "i", opts)).status, "failed");

  mockFetch(respond(200, { success: false, message: "no" }));
  assert.equal((await dispatchAlert("omnidimension", "call", target, "m", ctx, "i", opts)).status, "failed");

  mockFetch(respond(503, {}));
  assert.equal((await dispatchAlert("omnidimension", "call", target, "m", ctx, "i", opts)).status, "unknown");

  mockFetch(async () => { throw new Error("ECONNRESET"); });
  assert.equal((await dispatchAlert("omnidimension", "call", target, "m", ctx, "i", opts)).status, "unknown");

  mockFetch(hang);
  const started = Date.now();
  const timedOut = await dispatchAlert("omnidimension", "call", target, "m", ctx, "i", opts);
  assert.equal(timedOut.status, "unknown");
  assert.ok(Date.now() - started < 2000);
});

test("the existing real-alert caller does not opt in to timeout mode", () => {
  const handler = readFileSync(new URL("../../src/handler.ts", import.meta.url), "utf8");
  const calls = handler.match(/dispatchAlert\([^)]*\)/g) ?? [];
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes("timeoutMs"), calls[0]);
  assert.match(calls[0], /dispatchAlert\(provider, channel, target, message, context, id\)/);
});
