// River Watch: every major river in India (and the Nepal / Bangladesh reaches that feed it), checked against
// GloFAS forecasts. Pure TS so the browser and the scheduled worker share it.
//
// For each river point we keep three numbers from the 2025 monsoon (1 Jun - 31 Oct 2025, GloFAS):
//   p50 = a normal monsoon day, p90 = a high monsoon day, max = the highest day of the 2025 monsoon.
// Status uses the GloFAS forecast peak over the next 7 days:
//   DANGER  peak >= 2025 monsoon highest (shown as "Above 2025 peak")
//   WARNING peak >= 2025 monsoon p90
//   RISING  peak >= 1.25 x today and above a normal monsoon day
//   NORMAL  otherwise
export type RiverPoint = { id: number; river: string; lat: number; lng: number; glat: number; glng: number; near: string; state: string; p50: number; p90: number; max: number; rel: number | null; nv: number }
export type Village = { id: number; n: string; lat: number; lng: number; st: string; dr: number; h: number | null; p: number }
export type Status = 'NORMAL' | 'RISING' | 'WARNING' | 'DANGER'
export type Trend = 'rising' | 'falling' | 'steady'
export type PointStatus = { id: number; status: Status; trend: Trend; now: number; peak: number; peakDay: number; crossDay: number | null; ratio: number; series: number[]; days: string[]; today: number }

export const STATUS_ORDER: Status[] = ['NORMAL', 'RISING', 'WARNING', 'DANGER']

export function statusOf(p: RiverPoint, days: string[], q: (number | null)[], todayIso: string): PointStatus {
  const series = q.map(v => (v === null || v === undefined ? NaN : v))
  let today = days.indexOf(todayIso); if (today < 0) today = Math.max(0, days.findIndex(d => d > todayIso) - 1)
  const now = series[today]
  const fut = series.slice(today, today + 8).filter(Number.isFinite)
  const peak = fut.length ? Math.max(...fut) : now
  const peakDay = series.slice(today, today + 8).indexOf(peak)
  const status: Status = peak >= p.max ? 'DANGER' : peak >= p.p90 ? 'WARNING' : peak >= 1.25 * now && peak >= p.p50 ? 'RISING' : 'NORMAL'
  const thr = status === 'DANGER' ? p.max : status === 'WARNING' ? p.p90 : null
  let crossDay: number | null = null
  if (thr !== null) for (let k = 0; k < 8; k++) if (series[today + k] >= thr) { crossDay = k; break }
  const later = series[today + 3]
  const trend: Trend = peakDay > 0 && peak > now * 1.05 ? 'rising' : Number.isFinite(later) && later < now * 0.95 ? 'falling' : 'steady'
  return { id: p.id, status, trend, now, peak, peakDay, crossDay, ratio: p.max > 0 ? peak / p.max : 0, series, days, today }
}

/** Low-lying riverside villages for a point in WARNING or DANGER (estimate: distance to river and height above it). */
export function villagesAtRisk(st: PointStatus, vs: Village[]) {
  if (st.status !== 'WARNING' && st.status !== 'DANGER') return []
  const maxD = st.status === 'DANGER' ? 6 : 3, maxH = st.status === 'DANGER' ? 6 : 3
  return vs.filter(v => v.dr <= maxD && v.h !== null && v.h >= -3 && v.h <= maxH).sort((a, b) => (a.h ?? 0) - (b.h ?? 0) || a.dr - b.dr)
}

export function summarise(sts: PointStatus[], pts: Map<number, RiverPoint>) {
  const by: Record<Status, number> = { NORMAL: 0, RISING: 0, WARNING: 0, DANGER: 0 }
  sts.forEach(s => by[s.status]++)
  const rivers = (f: (s: PointStatus) => boolean) => [...new Set(sts.filter(f).map(s => pts.get(s.id)!.river))]
  const alert = rivers(s => needsAlert(s)), high = rivers(s => (s.status === 'WARNING' || s.status === 'DANGER') && !needsAlert(s)), rising = rivers(s => s.status === 'RISING')
  const pl = (n: number) => `${n} river${n === 1 ? '' : 's'}`
  const worst: Status = alert.length ? (sts.some(s => needsAlert(s) && s.status === 'DANGER') ? 'DANGER' : 'WARNING') : rising.length ? 'RISING' : 'NORMAL'
  const headline = alert.length ? `${pl(alert.length)} rising to flood levels` : rising.length ? `${pl(rising.length)} rising, none to flood levels yet` : high.length ? `No river rising to flood levels` : 'All rivers normal'
  const sub = high.length ? `${pl(high.length)} still high but falling (${high.slice(0, 3).join(', ')}${high.length > 3 ? '…' : ''}).` : ''
  return { by, worst, headline, sub, alert, high, rising }
}

/** Operator alerts are opened only for a coming rise, not for a river that is already high and falling. */
export const needsAlert = (s: PointStatus) => (s.status === 'WARNING' || s.status === 'DANGER') && s.trend === 'rising'
