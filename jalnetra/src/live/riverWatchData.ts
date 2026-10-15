import { STATUS_ORDER, statusOf, type PointStatus, type RiverPoint, type Status, type Trend } from '../engine/india'
import { API } from '../ops'

export type Run = { at: number; date: string; statuses: PointStatus[]; source: 'live' | 'server' | 'replay'; alerts?: number }
export const FRESH_MS = 6 * 3600e3
export const REQUEST_TIMEOUT_MS = 15_000
const PUBLIC = 'https://oceaylrebzflgyxfjqfb.supabase.co/functions/v1/jalnetra-public'
const OWN_SNAPSHOT = '/india/snapshot.json'
export const isFresh = (run: Run, now = Date.now()) => now >= run.at && now - run.at < FRESH_MS

export class RiverDataError extends Error {
  retryAt: number
  constructor(message: string, retryAt = 0) { super(message); this.name = 'RiverDataError'; this.retryAt = retryAt }
}

/** Includes response-body reading in the deadline; never retries a rate-limited request. */
export async function requestJson(url: string, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: () => void = () => {}
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => { controller.abort(); reject(new DOMException('Request cancelled', 'AbortError')) }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => { controller.abort(); reject(new RiverDataError('Request timed out. Please try again.')) }, timeoutMs)
  })
  try {
    return await Promise.race([stopped, (async () => {
      if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError')
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) {
        if (response.status === 429) {
          const header = response.headers.get('Retry-After')
          const seconds = header && /^\d+$/.test(header) ? Number(header) * 1000 : 0
          const retryAt = Math.max(Date.now() + 60_000, seconds ? Date.now() + seconds : Date.parse(header ?? '') || 0)
          throw new RiverDataError('Service rate limit (HTTP 429). Wait for the retry countdown.', retryAt)
        }
        throw new RiverDataError(`Service unavailable (HTTP ${response.status}). Please try again later.`)
      }
      const body: unknown = await response.json()
      if (isRecord(body) && body.error) throw new RiverDataError(`Service error: ${typeof body.reason === 'string' ? body.reason.slice(0, 240) : 'forecast unavailable'}`)
      return body
    })()])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const flow = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0
const offset = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 7

export function parseServerSnapshot(body: unknown, points: RiverPoint[], now = Date.now()): Run {
  const r = isRecord(body) && isRecord(body.river) ? body.river : null
  const at = r && typeof r.created_at === 'string' ? Date.parse(r.created_at) : NaN
  if (!r || !Number.isFinite(at) || at > now || !Array.isArray(r.statuses) || r.statuses.length !== points.length || !points.length) throw new RiverDataError('Monitor snapshot is missing or invalid.')
  const p = new Map(points.map(point => [point.id, point]))
  const seen = new Set<number>()
  const statuses = r.statuses.map((s: unknown): PointStatus => {
    if (!Array.isArray(s)) throw new RiverDataError('Invalid monitor status.')
    const [id, status, current, peak, peakDay, crossDay, trend] = s
    if (!p.has(id) || seen.has(id) || !STATUS_ORDER.includes(status) || !flow(current) || !flow(peak) || peak < current || !offset(peakDay) || !(crossDay === null || offset(crossDay)) || !['rising', 'falling', 'steady'].includes(trend)) throw new RiverDataError('Monitor snapshot has incomplete or invalid river statuses.')
    seen.add(id)
    return { id, status: status as Status, trend: trend as Trend, now: current, peak, peakDay, crossDay, ratio: peak / Math.max(p.get(id)!.max, 1), series: [], days: [], today: 0 }
  })
  return { at, date: new Date(at).toISOString().slice(0, 10), statuses, source: 'server' }
}

/** Require the full forecast horizon so missing discharge cannot become a Normal result. */
export function parseForecastBatch(body: unknown, points: RiverPoint[], date: string): PointStatus[] {
  const rows = Array.isArray(body) ? body : [body]
  if (!points.length || rows.length !== points.length) throw new RiverDataError('Incomplete GloFAS batch: river count does not match.')
  return rows.map((row, i) => {
    const p = points[i]
    if (!isRecord(row) || row.error) throw new RiverDataError('GloFAS returned an error instead of a river forecast.')
    // location_id is the request index. Coordinates also protect single-point responses
    // and services that omit location_id; allow one ~5 km grid-cell snap.
    if ((row.location_id !== undefined && row.location_id !== i) || typeof row.latitude !== 'number' || typeof row.longitude !== 'number' || !Number.isFinite(row.latitude) || !Number.isFinite(row.longitude) || Math.abs(row.latitude - p.glat) > 0.08 || Math.abs(row.longitude - p.glng) > 0.08) throw new RiverDataError('GloFAS river order/location does not match the request.')
    const daily = isRecord(row.daily) ? row.daily : null
    const days = daily?.time, q = daily?.river_discharge
    if (!Array.isArray(days) || !Array.isArray(q) || days.length !== q.length || !days.length || days.some((d, k) => typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || (k > 0 && Date.parse(d) - Date.parse(days[k - 1]) !== 86400e3)) || q.some(v => v !== null && !flow(v))) throw new RiverDataError('Malformed GloFAS daily discharge data.')
    const today = days.indexOf(date)
    if (today < 0 || q.length < today + 8 || q.slice(today, today + 8).some(v => !flow(v))) throw new RiverDataError('GloFAS has no complete current-day and seven-day discharge forecast.')
    return statusOf(p, days, q, date)
  })
}

const forecastUrl = (points: RiverPoint[], pastDays: number) => `${API}/proxy/flood?latitude=${points.map(p => p.glat).join(',')}&longitude=${points.map(p => p.glng).join(',')}&daily=river_discharge&past_days=${pastDays}&forecast_days=8`
export async function pointSeries(p: RiverPoint, signal: AbortSignal): Promise<PointStatus> {
  return parseForecastBatch(await requestJson(forecastUrl([p], 10), signal), [p], new Date().toISOString().slice(0, 10))[0]
}

export async function liveRun(points: RiverPoint[], signal: AbortSignal): Promise<Run> {
  const date = new Date().toISOString().slice(0, 10)
  const statuses: PointStatus[] = []
  for (let i = 0; i < points.length; i += 90) {
    const batch = points.slice(i, i + 90)
    statuses.push(...parseForecastBatch(await requestJson(forecastUrl(batch, 3), signal), batch, date))
  }
  if (!statuses.length) throw new RiverDataError('No river points available.')
  return { at: Date.now(), date, statuses, source: 'live' }
}

export async function refreshRun(points: RiverPoint[], previous: Run | null, signal: AbortSignal): Promise<{ run: Run | null; error: string | null; retryAt: number }> {
  let fallback = previous?.source !== 'replay' ? previous : null
  let monitorError = ''
  let retryAt = 0
  // JalNetra's own monitor snapshot (AWS Lambda + EventBridge Scheduler -> S3 -> CloudFront) first, then the older public monitor.
  for (const url of [OWN_SNAPSHOT, PUBLIC]) {
    try {
      const snapshot = parseServerSnapshot(await requestJson(url, signal), points)
      if (!fallback || snapshot.at > fallback.at) fallback = snapshot
      if (isFresh(snapshot)) return { run: snapshot, error: null, retryAt: 0 }
    } catch (error) {
      if (signal.aborted) throw error
      monitorError = `Monitor: ${(error as Error).message} `
      retryAt = error instanceof RiverDataError ? error.retryAt : 0
    }
  }
  try { return { run: await liveRun(points, signal), error: null, retryAt } }
  catch (error) {
    if (signal.aborted) throw error
    return { run: fallback, error: `${monitorError}Fresh GloFAS data unavailable: ${(error as Error).message}`, retryAt: Math.max(retryAt, error instanceof RiverDataError ? error.retryAt : 0) }
  }
}
