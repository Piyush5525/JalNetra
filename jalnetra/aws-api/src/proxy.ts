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

export function createForecastProxy(deps: { fetch: Fetch; now?: () => number }) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, Entry>();
  const inflight = new Map<string, Promise<ProxyReply>>();

  function remember(key: string, body: string) {
    cache.set(key, { at: now(), body });
    if (cache.size > MAX_ENTRIES) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
      if (oldest) cache.delete(oldest);
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
      if (response.status === 429) return staleOr("upstream rate limited") ?? reply(429, { error: "The weather service is rate limiting. Try again shortly." }, { "Retry-After": "60" });
      return staleOr(`upstream HTTP ${response.status}`) ?? reply(502, { error: `Upstream unavailable (HTTP ${response.status})` });
    } catch {
      return staleOr("upstream unreachable") ?? reply(502, { error: "Upstream unreachable" });
    } finally {
      clearTimeout(timer);
    }
  }

  return async function route(method: string, path: string, rawQuery: string): Promise<ProxyReply | null> {
    const base = UPSTREAM[path];
    if (!base) return null;
    if (method !== "GET") return reply(405, { error: "GET only" });
    const normalised = normaliseQuery(rawQuery);
    if ("error" in normalised) return reply(400, { error: normalised.error });
    const key = `${path}?${normalised.query}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < FRESH_MS) return reply(200, hit.body, { "x-jalnetra-cache": "hit", "x-jalnetra-cached-at": new Date(hit.at).toISOString(), "cache-control": "public, max-age=300" });
    let pending = inflight.get(key);
    if (!pending) {
      pending = fetchUpstream(base, normalised.query, key).finally(() => inflight.delete(key));
      inflight.set(key, pending);
    }
    return pending;
  };
}

let shared: ReturnType<typeof createForecastProxy> | null = null;
export async function routeForecastProxy(method: string, path: string, rawQuery: string): Promise<ProxyReply | null> {
  shared ??= createForecastProxy({ fetch: (url, init) => fetch(url, init) as ReturnType<Fetch> });
  return shared(method, path, rawQuery);
}
