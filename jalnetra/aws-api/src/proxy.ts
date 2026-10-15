import { readFileSync, writeFileSync } from "node:fs";

// Cached, read-only pass-through to the free Open-Meteo APIs.
//
// Why: the website used to call Open-Meteo straight from every visitor's browser, so the free tier's per-IP limits (HTTP 429)
// were hit as soon as a few people looked at the map. Here the API calls Open-Meteo itself, from one place, and keeps each answer
// for a few hours (GloFAS river discharge changes once a day). If Open-Meteo refuses, the last good answer is returned, clearly
// marked, instead of an error. It is an allow-list, not an open proxy: two fixed upstream paths and a small set of parameters.

const UPSTREAM: Record<string, string> = {
  "/proxy/flood": "https://flood-api.open-meteo.com/v1/flood",
  "/proxy/forecast": "https://api.open-meteo.com/v1/forecast",
};
const POPULATION_UPSTREAM = "https://api.worldpop.org/v1/services/stats";
const ALLOWED_PARAMS = new Set(["latitude", "longitude", "daily", "hourly", "past_days", "forecast_days", "timezone", "forecast_hours"]);
const VALUE = /^[A-Za-z0-9_.,:\-\/]{1,6000}$/;
export const FRESH_MS = 3 * 3600e3;
export const STALE_OK_MS = 7 * 86400e3;
const MAX_ENTRIES = 300;
const MAX_POINTS = 120;
const UPSTREAM_TIMEOUT_MS = 12_000;

export type ProxyReply = { status: number; body: string; headers: Record<string, string> };
type Entry = { at: number; body: string };
type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string>; headers: { get(name: string): string | null } }>;

const reply = (status: number, body: unknown, headers: Record<string, string> = {}): ProxyReply => ({ status, body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });

/** Returns the canonical query string, or an error message. Order is normalised so equal requests share one cache entry. */
export function normaliseQuery(raw: string): { query: string } | { error: string } {
  const params = new URLSearchParams(raw);
  const out: [string, string][] = [];
  for (const [key, value] of params) {
    if (!ALLOWED_PARAMS.has(key)) return { error: `Parameter not allowed: ${key}` };
    if (!VALUE.test(value)) return { error: `Invalid value for ${key}` };
    out.push([key, value]);
  }
  const get = (k: string) => out.find(([key]) => key === k)?.[1];
  const lat = get("latitude"), lng = get("longitude");
  if (!lat || !lng) return { error: "latitude and longitude are required" };
  const lats = lat.split(","), lngs = lng.split(",");
  if (lats.length !== lngs.length || lats.length > MAX_POINTS) return { error: `Between 1 and ${MAX_POINTS} matching coordinates are allowed` };
  if (![...lats, ...lngs].every((v) => /^-?\d{1,3}(\.\d{1,6})?$/.test(v))) return { error: "Coordinates must be numbers" };
  out.sort((a, b) => a[0].localeCompare(b[0]));
  return { query: out.map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%2C/gi, ",")}`).join("&") };
}

/** WorldPop population-in-polygon: only small, validated GeoJSON polygons over South Asia are forwarded. */
export function normalisePopulation(raw: string): { query: string } | { error: string } {
  const params = new URLSearchParams(raw);
  const year = Number(params.get("year") ?? "2020");
  if (!Number.isInteger(year) || year < 2000 || year > 2020) return { error: "year must be 2000 to 2020" };
  let parsed: unknown;
  try { parsed = JSON.parse(params.get("geojson") ?? ""); } catch { return { error: "geojson must be valid JSON" }; }
  const fc = parsed as { type?: string; features?: { type?: string; geometry?: { type?: string; coordinates?: unknown } }[] };
  if (fc?.type !== "FeatureCollection" || !Array.isArray(fc.features) || fc.features.length < 1 || fc.features.length > 6) return { error: "geojson must be a FeatureCollection of 1 to 6 polygons" };
  let vertices = 0;
  for (const f of fc.features) {
    const rings = f?.geometry?.type === "Polygon" ? f.geometry.coordinates : null;
    if (!Array.isArray(rings) || rings.length < 1 || rings.length > 4) return { error: "each feature must be a Polygon" };
    for (const ring of rings as unknown[]) {
      if (!Array.isArray(ring) || ring.length < 4) return { error: "invalid ring" };
      for (const pt of ring as unknown[]) {
        if (!Array.isArray(pt) || pt.length !== 2 || typeof pt[0] !== "number" || typeof pt[1] !== "number") return { error: "invalid coordinate" };
        if (pt[0] < 60 || pt[0] > 100 || pt[1] < 5 || pt[1] > 40) return { error: "coordinates outside South Asia" };
        vertices++;
      }
    }
  }
  if (vertices > 300) return { error: "too many vertices" };
  return { query: `dataset=wpgppop&runasync=true&year=${year}&geojson=${encodeURIComponent(JSON.stringify(fc))}` };
}

export function createForecastProxy(deps: { fetch: Fetch; now?: () => number; persist?: { load(): Record<string, Entry>; save(all: Record<string, Entry>): void } }) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, Entry>();
  // Optional disk copy so a restart (or an Open-Meteo 429) still has the last good answer.
  try { for (const [k, v] of Object.entries(deps.persist?.load() ?? {})) if (v && typeof v.body === "string" && typeof v.at === "number") cache.set(k, v); } catch { /* start empty */ }
  const inflight = new Map<string, Promise<ProxyReply>>();
  // Open-Meteo's free tier has a daily quota that resets at 00:00 UTC; once it says so, stop asking until then.
  let dailyBlockUntil = 0;

  function remember(key: string, body: string) {
    cache.set(key, { at: now(), body });
    try { deps.persist?.save(Object.fromEntries(cache)); } catch { /* disk is best effort */ }
    if (cache.size > MAX_ENTRIES) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
      if (oldest) cache.delete(oldest);
    }
  }

  /** WorldPop runs as a task: create returns a task id at once, and the client polls the task until it has finished. */
  async function populationRoute(path: string, rawQuery: string): Promise<ProxyReply> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      if (path === "/proxy/population") {
        const normalised = normalisePopulation(rawQuery);
        if ("error" in normalised) return reply(400, { error: normalised.error });
        const response = await deps.fetch(`${POPULATION_UPSTREAM}?${normalised.query}`, { signal: controller.signal });
        const text = await response.text();
        if (!response.ok) return reply(502, { error: `Population service unavailable (HTTP ${response.status})` });
        return reply(200, text, { "cache-control": "no-store" });
      }
      const id = new URLSearchParams(rawQuery).get("id") ?? "";
      if (!/^[a-f0-9-]{36}$/.test(id)) return reply(400, { error: "invalid task id" });
      const key = `task:${id}`;
      const hit = cache.get(key);
      if (hit) return reply(200, hit.body, { "x-jalnetra-cache": "hit" });
      const response = await deps.fetch(`https://api.worldpop.org/v1/tasks/${id}`, { signal: controller.signal });
      const text = await response.text();
      if (!response.ok) return reply(502, { error: `Population service unavailable (HTTP ${response.status})` });
      try { if ((JSON.parse(text) as { status?: string }).status === "finished") remember(key, text); } catch { /* not JSON: pass through */ }
      return reply(200, text, { "cache-control": "no-store" });
    } catch {
      return reply(502, { error: "Population service unreachable" });
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchUpstream(base: string, query: string, key: string): Promise<ProxyReply> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    const stale = cache.get(key);
    const staleOr = (why: string): ProxyReply | null => stale && now() - stale.at < STALE_OK_MS
      ? reply(200, stale.body, { "x-jalnetra-cache": "stale", "x-jalnetra-cached-at": new Date(stale.at).toISOString(), "x-jalnetra-note": why })
      : null;
    try {
      const response = await deps.fetch(`${base}?${query}`, { signal: controller.signal });
      const text = await response.text();
      if (response.ok) {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { return staleOr("upstream returned invalid JSON") ?? reply(502, { error: "Upstream returned an invalid response" }); }
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as { error?: unknown }).error) {
          return staleOr("upstream reported an error") ?? reply(502, { error: "Upstream reported an error", reason: String((parsed as { reason?: unknown }).reason ?? "").slice(0, 200) });
        }
        remember(key, text);
        return reply(200, text, { "x-jalnetra-cache": "miss", "x-jalnetra-cached-at": new Date(now()).toISOString() });
      }
      if (response.status === 429 && /daily/i.test(text)) { const reset = new Date(now()); reset.setUTCHours(24, 5, 0, 0); dailyBlockUntil = reset.getTime(); }
      if (response.status === 429) return staleOr("upstream rate limited") ?? reply(429, { error: "The weather service is rate limiting. Try again shortly." }, { "Retry-After": "60" });
      return staleOr(`upstream HTTP ${response.status}`) ?? reply(502, { error: `Upstream unavailable (HTTP ${response.status})` });
    } catch {
      return staleOr("upstream unreachable") ?? reply(502, { error: "Upstream unreachable" });
    } finally {
      clearTimeout(timer);
    }
  }

  return async function route(method: string, path: string, rawQuery: string): Promise<ProxyReply | null> {
    if (path === "/proxy/population" || path === "/proxy/population/task") {
      if (method !== "GET") return reply(405, { error: "GET only" });
      return populationRoute(path, rawQuery);
    }
    const base = UPSTREAM[path];
    if (!base) return null;
    if (method !== "GET") return reply(405, { error: "GET only" });
    const normalised = normaliseQuery(rawQuery);
    if ("error" in normalised) return reply(400, { error: normalised.error });
    const key = `${path}?${normalised.query}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < FRESH_MS) return reply(200, hit.body, { "x-jalnetra-cache": "hit", "x-jalnetra-cached-at": new Date(hit.at).toISOString(), "cache-control": "public, max-age=300" });
    if (now() < dailyBlockUntil) {
      const stale = cache.get(key);
      if (stale && now() - stale.at < STALE_OK_MS) return reply(200, stale.body, { "x-jalnetra-cache": "stale", "x-jalnetra-cached-at": new Date(stale.at).toISOString(), "x-jalnetra-note": "upstream daily limit reached" });
      return reply(429, { error: "The weather service's daily limit is reached; it resets at 00:00 UTC." }, { "Retry-After": "3600" });
    }
    let pending = inflight.get(key);
    if (!pending) {
      pending = fetchUpstream(base, normalised.query, key).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return pending;
  };
}

// Set JN_PROXY_CACHE_FILE (local backend only) to keep the cache across restarts.
function persistFromEnv() {
  const file = process.env.JN_PROXY_CACHE_FILE;
  if (!file) return undefined;
  return {
    load: () => JSON.parse(readFileSync(file, "utf8")) as Record<string, Entry>,
    save: (all: Record<string, Entry>) => writeFileSync(file, JSON.stringify(all)),
  };
}

let shared: ReturnType<typeof createForecastProxy> | null = null;
export async function routeForecastProxy(method: string, path: string, rawQuery: string): Promise<ProxyReply | null> {
  shared ??= createForecastProxy({ fetch: (url, init) => fetch(url, init) as ReturnType<Fetch>, persist: persistFromEnv() });
  return shared(method, path, rawQuery);
}
