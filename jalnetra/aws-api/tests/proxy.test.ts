import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createForecastProxy, normaliseQuery } from "../src/proxy.js";

const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body), headers: { get: () => null } });
const status = (code: number) => ({ ok: false, status: code, text: async () => "{}", headers: { get: () => null } });
const Q = "latitude=27.7,26.9&longitude=84.3,84.1&daily=river_discharge&past_days=3";

describe("forecast proxy", () => {
  it("rejects parameters outside the allow-list and bad coordinates", () => {
    assert.ok("error" in normaliseQuery("latitude=1&longitude=2&apikey=x"));
    assert.ok("error" in normaliseQuery("latitude=abc&longitude=2"));
    assert.ok("error" in normaliseQuery("latitude=1"));
    assert.ok("query" in normaliseQuery(Q));
  });
  it("serves repeated requests from cache and calls upstream once", async () => {
    let calls = 0;
    const route = createForecastProxy({ fetch: async () => { calls++; return ok({ daily: { river_discharge: [1] } }); } });
    const a = await route("GET", "/proxy/flood", Q);
    const b = await route("GET", "/proxy/flood", "past_days=3&daily=river_discharge&longitude=84.3,84.1&latitude=27.7,26.9");
    assert.equal(a?.status, 200); assert.equal(b?.status, 200);
    assert.equal(b?.headers["x-jalnetra-cache"], "hit");
    assert.equal(calls, 1);
  });
  it("returns the last good answer, marked stale, when upstream rate limits", async () => {
    let t = 0, limited = false;
    const route = createForecastProxy({ now: () => t, fetch: async () => (limited ? status(429) : ok({ daily: { river_discharge: [2] } })) });
    await route("GET", "/proxy/flood", Q);
    t += 4 * 3600e3; limited = true;
    const r = await route("GET", "/proxy/flood", Q);
    assert.equal(r?.status, 200);
    assert.equal(r?.headers["x-jalnetra-cache"], "stale");
    assert.match(r!.body, /river_discharge/);
  });
  it("passes a 429 through only when there is nothing cached", async () => {
    const route = createForecastProxy({ fetch: async () => status(429) });
    const r = await route("GET", "/proxy/forecast", Q);
    assert.equal(r?.status, 429);
    assert.equal(r?.headers["Retry-After"], "60");
  });
  it("ignores unrelated paths and refuses non-GET", async () => {
    const route = createForecastProxy({ fetch: async () => ok({}) });
    assert.equal(await route("GET", "/incidents", Q), null);
    assert.equal((await route("POST", "/proxy/flood", Q))?.status, 405);
  });
});
