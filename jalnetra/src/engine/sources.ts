// Live inputs. River discharge: GloFAS v4 through the Open-Meteo Flood API (daily; there is no public real-time
// gauge feed for the Gandak, so the "current" value is GloFAS's own estimate). Rain: Open-Meteo, 4 points in the
// Nepal catchment, past 3 days observed and next 3 days forecast.
import type { Inputs, ModelParams, Observation } from './core'
import { API } from '../ops'

const day = (d: string) => Date.parse(d + 'T12:00:00Z')

export async function liveInputs(M: ModelParams): Promise<Inputs> {
  const S = M.stations, R = M.rainPoints
  const fu = `${API}/proxy/flood?latitude=${S.map(s => s.glat).join(',')}&longitude=${S.map(s => s.glng).join(',')}&daily=river_discharge,river_discharge_max,river_discharge_min&past_days=7&forecast_days=7`
  const ru = `${API}/proxy/forecast?latitude=${R.map(p => p[0]).join(',')}&longitude=${R.map(p => p[1]).join(',')}&daily=precipitation_sum&past_days=3&forecast_days=3&timezone=UTC`
  const get = async (u: string, name: string) => {
    const x = await fetch(u).catch(() => null)
    if (x?.ok) return x.json()
    if (x?.status === 429) throw new Error(`${name} rate limited (HTTP 429); wait before retrying or use the replay demo`)
    throw new Error(`${name} unavailable${x ? ` (HTTP ${x.status})` : ''}`)
  }
  // river flow is required; rain is optional (the model runs on river data alone and says so)
  const [f, r] = await Promise.all([get(fu, 'GloFAS'), get(ru, 'Rain').catch(() => null)])
  const now = Date.now(), observations: Observation[] = []
  const stations = S.map((s, i) => {
    const d = f[i].daily as { time: string[]; river_discharge: number[]; river_discharge_max: number[]; river_discharge_min: number[] }
    const pts = d.time.map((t, k) => ({ t: day(t), q: d.river_discharge[k], lo: d.river_discharge_min[k], hi: d.river_discharge_max[k] })).filter(p => p.q !== null)
    pts.forEach(p => observations.push({ ts: new Date(p.t).toISOString(), lat: s.glat, lng: s.glng, source: 'GloFAS v4 via Open-Meteo', type: 'river_discharge', value: p.q, unit: 'm3/s', confidence: p.t <= now ? 'medium' : 'low', forecast: p.t > now }))
    return { known: pts.filter(p => p.t <= now).map(p => ({ t: p.t, q: p.q })), glofas: pts.filter(p => p.t > now) }
  })
  if (!r) return { now, mode: 'live', stations, rain: [], observations, rainMissing: true } as Inputs
  const days: string[] = r[0].daily.time
  const rain = days.map((t, k) => {
    const mm = R.reduce((a, _, j) => a + (r[j].daily.precipitation_sum[k] ?? 0), 0) / R.length
    return { t: day(t), mm, forecast: day(t) > now }
  })
  R.forEach((p, j) => days.forEach((t, k) => observations.push({ ts: day(t) ? new Date(day(t)).toISOString() : t, lat: p[0], lng: p[1], source: 'Open-Meteo', type: 'rainfall', value: r[j].daily.precipitation_sum[k] ?? 0, unit: 'mm/day', confidence: day(t) > now ? 'low' : 'medium', forecast: day(t) > now })))
  return { now, mode: 'live', stations, rain, observations }
}
