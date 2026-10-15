// JalNetra prediction engine. Pure TypeScript (no DOM) so the same file runs in the browser and in the
// monitoring worker. Every number it produces comes from the inputs plus the parameters in model.json,
// which were fitted to the September 2026 Gandak flood (Sentinel-1 radar + GloFAS discharge + Open-Meteo rain).

export type ModelParams = {
  version: string
  stations: { name: string; label: string; km: number; lng: number; lat: number; glat: number; glng: number }[]
  celerity: number
  event: { start: string; q: number[][]; rain: number[] }
  village: { b0: number; b: number[]; features: string[]; loo: Record<string, { b0: number; b: number[] }>; warn: number }
  pixel: { b0: number; b: number[]; pstar: number }
  villages: { id: number; ch: number; h10: number; hc: number; d: number; name: string; district: string; lng: number; lat: number }[]
  rain: { kappa: number; tp: number }
  rainPoints: [number, number][]
  obsTimes: Record<string, string>
}

/** Normalised observation: every input the engine uses is stored in this shape. */
export type Observation = { ts: string; lat: number; lng: number; source: string; type: 'river_discharge' | 'rainfall' | 'flood_extent'; value: number; unit: string; confidence: 'high' | 'medium' | 'low'; forecast?: boolean }

export type Mode = 'live' | 'demo' | 'replay'
export type StationInput = { known: { t: number; q: number }[]; glofas?: { t: number; q: number; lo: number; hi: number }[] }
export type Inputs = { now: number; mode: Mode; stations: StationInput[]; rain: { t: number; mm: number; forecast: boolean }[]; observations: Observation[]; rainMissing?: boolean }

export const HORIZONS = [0, 3, 6, 12, 24] as const
export const H = 1, PAST = 72, FUT = 48 // hourly grid from -72 h to +48 h
const HR = 3600e3

export type StationForecast = {
  name: string; label: string; km: number
  q: number[]; lo: number[]; hi: number[] // index h + PAST, h = -72..48
  q0: number; trend: 'Rising rapidly' | 'Rising' | 'Steady' | 'Falling'; rise6: number
  conf: ('High' | 'Medium' | 'Low')[] // per HORIZONS
  parts: { trend: number; route: number; rain: number; glofas: number | null }[] // per HORIZONS, m3/s change vs now
}

const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x))
const lerpSeries = (pts: { t: number; q: number }[], t: number) => {
  if (!pts.length) return NaN
  if (t <= pts[0].t) return pts[0].q
  for (let i = 1; i < pts.length; i++) if (t <= pts[i].t) { const f = (t - pts[i - 1].t) / (pts[i].t - pts[i - 1].t); return pts[i - 1].q * (1 - f) + pts[i].q * f }
  // beyond the last known point: carry the last slope forward for up to 36 h, then hold
  const a = pts[pts.length - 2] ?? pts[pts.length - 1], b = pts[pts.length - 1]
  const s = a === b ? 0 : (b.q - a.q) / (b.t - a.t)
  return Math.max(b.q * 0.5, b.q + s * Math.min(t - b.t, 36 * HR))
}
const unit = (x: number, tp: number) => (x > 0 ? (x / tp) * Math.exp(1 - x / tp) : 0)

/** River forecast: damped trend + upstream routing + rain response, blended with GloFAS when available. */
export function forecast(M: ModelParams, inp: Inputs): StationForecast[] {
  const out: StationForecast[] = []
  const { kappa, tp } = M.rain
  const pulses = inp.rain.filter(r => inp.mode === 'live' || !r.forecast)
  for (let i = 0; i < M.stations.length; i++) {
    const s = M.stations[i], known = inp.stations[i].known.filter(p => p.t <= inp.now)
    const Qp = (h: number) => lerpSeries(known, inp.now + h * HR)
    const q0 = Qp(0), slope = (q0 - Qp(-12)) / 12, tau = 10
    const q = new Array(PAST + FUT + 1).fill(0), lo = [...q], hi = [...q]
    for (let h = -PAST; h <= 0; h++) { const v = Qp(h); q[h + PAST] = v; lo[h + PAST] = v; hi[h + PAST] = v }
    const lag = i === 0 ? 0 : (s.km - M.stations[i - 1].km) / M.celerity
    const up = out[i - 1]
    const upAt = (h: number) => { const k = Math.round(h) + PAST; return up.q[Math.max(0, Math.min(up.q.length - 1, k))] }
    const g = inp.stations[i].glofas?.filter(p => p.t > inp.now) ?? []
    const gAt = (h: number) => (g.length ? lerpSeries([{ t: inp.now, q: q0 }, ...g.map(p => ({ t: p.t, q: p.q }))], inp.now + h * HR) : null)
    const parts: StationForecast['parts'] = []
    for (let h = 1; h <= FUT; h++) {
      const dTrend = slope * tau * (1 - Math.exp(-h / tau))
      const dRoute = i === 0 ? 0 : upAt(h - lag) - upAt(-lag)
      let dRain = 0
      if (i === 0) for (const r of pulses) { const age = (inp.now - r.t) / HR; dRain += kappa * r.mm * (unit(age + h, tp) - unit(age, tp)) }
      let v = i === 0 ? q0 + 0.5 * dTrend + dRain : q0 + 0.65 * dRoute + 0.35 * dTrend
      const gv = gAt(h)
      let rel = 0.04 + 0.006 * h
      if (gv !== null) { const w = Math.exp(-h / 18); rel += 0.5 * Math.abs(v - gv) / Math.max(v, 1); v = w * v + (1 - w) * gv }
      v = Math.max(v, q0 * 0.3)
      q[h + PAST] = v; lo[h + PAST] = v * (1 - rel); hi[h + PAST] = v * (1 + rel)
      if ((HORIZONS as readonly number[]).includes(h)) parts.push({ trend: i === 0 ? 0.5 * dTrend : 0.35 * dTrend, route: 0.65 * dRoute, rain: dRain, glofas: gv === null ? null : gv - q0 })
    }
    parts.unshift({ trend: 0, route: 0, rain: 0, glofas: null })
    const conf = HORIZONS.map(h => { const r = (hi[h + PAST] - lo[h + PAST]) / 2 / Math.max(q[h + PAST], 1); return h === 0 ? 'High' : r < 0.08 ? 'High' : r < 0.16 ? 'Medium' : 'Low' }) as StationForecast['conf']
    const rise6 = (q[6 + PAST] - q0) / Math.max(q0, 1)
    const trend = rise6 > 0.08 ? 'Rising rapidly' : rise6 > 0.02 ? 'Rising' : rise6 < -0.02 ? 'Falling' : 'Steady'
    out.push({ name: s.name, label: s.label, km: s.km, q, lo, hi, q0, trend, rise6, conf, parts })
  }
  return out
}

/** Discharge at a river chainage (km below Devghat) for hour h, interpolated between forecast points. */
export function qAt(F: StationForecast[], km: number, h: number, band: 'q' | 'lo' | 'hi' = 'q') {
  const k = Math.max(0, Math.min(PAST + FUT, Math.round(h) + PAST))
  if (km <= F[0].km) return F[0][band][k]
  for (let i = 1; i < F.length; i++) if (km <= F[i].km) { const f = (km - F[i - 1].km) / (F[i].km - F[i - 1].km); return F[i - 1][band][k] * (1 - f) + F[i][band][k] * f }
  return F[F.length - 1][band][k]
}
/** Highest flow over the previous 72 h: flood water stays after the peak passes, so the model uses this. */
export function qEff(F: StationForecast[], km: number, h: number, band: 'q' | 'lo' | 'hi' = 'q') {
  let m = 0
  for (let x = 0; x <= 72; x += 6) m = Math.max(m, qAt(F, km, h - x, band))
  return m
}
/** Q-effective on a 2 km chainage table, for fast per-cell lookups. */
export function qEffTable(F: StationForecast[], h: number, band: 'q' | 'lo' | 'hi' = 'q') {
  const t = new Float32Array(200)
  for (let b = 0; b < 200; b++) t[b] = qEff(F, b * 2, h, band)
  return t
}

const sig = (z: number) => 1 / (1 + Math.exp(-z))
export const villageLogit = (c: { b0: number; b: number[] }, v: { h10: number; hc: number; d: number }, q: number) =>
  c.b0 + c.b[0] * Math.log(q / 4000) + c.b[1] * v.h10 + c.b[2] * v.hc + c.b[3] * v.d
export const villageP = (c: { b0: number; b: number[] }, v: { h10: number; hc: number; d: number }, q: number) => sig(villageLogit(c, v, q))
export const pixelP = (M: ModelParams, q: number, hand: number, d: number) => sig(M.pixel.b0 + M.pixel.b[0] * Math.log(q / 4000) + M.pixel.b[1] * hand + M.pixel.b[2] * d)

export type Level = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
export const LEVELS: Level[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']
export type VillageRisk = {
  id: number; p: number[] // probability per hour 0..48
  pAt: Record<number, number>; pMax: number; impactH: number | null; window: [number, number] | null
  score: number; level: Level; levelAt: Record<number, Level>; conf: 'High' | 'Medium' | 'Low'
  factors: { label: string; pts: number; max: number; detail: string }[]
  terms: { label: string; value: number }[] // logistic contributions at the impact (or +24 h) horizon
  action: string
}

export type Context = { rain48: number; rainFcst24: number }

export function villageRisk(M: ModelParams, F: StationForecast[], v: ModelParams['villages'][number], ctx: Context, coef = M.village): VillageRisk {
  const p: number[] = [], pHi: number[] = []
  for (let h = 0; h <= FUT; h++) { p.push(villageP(coef, v, qEff(F, v.ch, h))); pHi.push(villageP(coef, v, qEff(F, v.ch, h, 'hi'))) }
  const warn = M.village.warn
  const ih = p.findIndex(x => x >= warn)
  const impactH = ih < 0 ? null : ih
  const window: [number, number] | null = impactH === null ? null : impactH === 0 ? [0, 0] : [Math.max(0, Math.round(impactH * 0.8 - 1)), Math.round(impactH * 1.2 + 2)]
  const pMax = Math.max(...p.slice(0, 25))
  const near = F.reduce((a, s) => (Math.abs(s.km - v.ch) < Math.abs(a.km - v.ch) ? s : a))
  const factors = [
    { label: 'Flood probability', max: 45, pts: 45 * pMax, detail: `${Math.round(pMax * 100)}% within 24 h` },
    { label: 'Time to impact', max: 15, pts: impactH === null ? 0 : 15 * (1 - Math.min(impactH, 24) / 24), detail: impactH === null ? 'Not reached within 48 h' : impactH === 0 ? 'Now' : `~${impactH} h` },
    { label: 'Low ground', max: 10, pts: 10 * clamp((5 - v.h10) / 5), detail: `Lowest ground nearby ${v.h10.toFixed(1)} m above the channel` },
    { label: 'Near the river', max: 10, pts: 10 * clamp((5 - v.d) / 5), detail: `${v.d.toFixed(1)} km from the main channel` },
    { label: 'River rising', max: 10, pts: 10 * clamp(near.rise6 / 0.15), detail: `${near.label}: ${near.rise6 >= 0 ? '+' : ''}${Math.round(near.rise6 * 100)}% in 6 h` },
    { label: 'Rain', max: 10, pts: 10 * clamp((ctx.rain48 + ctx.rainFcst24) / 100), detail: `${Math.round(ctx.rain48)} mm in 48 h${ctx.rainFcst24 ? `, ${Math.round(ctx.rainFcst24)} mm forecast` : ''} (Nepal catchment)` },
  ]
  const score = Math.round(factors.reduce((a, f) => a + f.pts, 0))
  const lvl = (pp: number, sc: number, ttl: number | null): Level =>
    pp >= 0.5 && sc >= 65 && ttl !== null && ttl <= 12 ? 'CRITICAL' : pp >= 0.5 || sc >= 55 ? 'HIGH' : pp >= warn || sc >= 35 ? 'MEDIUM' : 'LOW'
  const level = lvl(pMax, score, impactH)
  const levelAt: Record<number, Level> = {}, pAt: Record<number, number> = {}
  for (const h of HORIZONS) {
    pAt[h] = p[h]
    // at a given horizon the village counts only once the water is predicted to have reached it
    levelAt[h] = p[h] >= warn ? (LEVELS.indexOf(level) >= 1 ? level : 'MEDIUM') : 'LOW'
  }
  const spread = pHi[24] - p[24]
  const conf = near.conf[4] === 'Low' || spread > 0.25 ? 'Low' : near.conf[3] === 'High' && spread < 0.1 ? 'High' : 'Medium'
  const hz = impactH ?? 24, qz = qEff(F, v.ch, hz)
  const terms = [
    { label: `River flow at this reach (${Math.round(qz).toLocaleString()} m³/s, 72 h high)`, value: coef.b[0] * Math.log(qz / 4000) },
    { label: `Lowest ground within 500 m: ${v.h10.toFixed(1)} m above channel`, value: coef.b[1] * v.h10 },
    { label: `Village centre: ${v.hc.toFixed(1)} m above channel`, value: coef.b[2] * v.hc },
    { label: `Distance to main channel: ${v.d.toFixed(1)} km`, value: coef.b[3] * v.d },
    { label: 'Baseline', value: coef.b0 },
  ]
  const action = level === 'CRITICAL' ? 'Evacuate now' : level === 'HIGH' ? 'Prepare evacuation, alert sarpanch' : level === 'MEDIUM' ? 'Watch closely, check shelter and route' : 'No action needed'
  return { id: v.id, p, pAt, pMax, impactH, window, score, level, levelAt, conf, factors, terms, action }
}

export type ModelRun = {
  at: string; now: number; mode: Mode; version: string
  stations: StationForecast[]; villages: VillageRisk[]
  counts: Record<number, Record<Level, number>> // per horizon
  atRisk: number; overall: Level; river: StationForecast['trend']; rainLevel: 'LOW' | 'MODERATE' | 'HIGH'; ctx: Context
  inputs: { observations: number; byType: Record<string, number> }; rainMissing?: boolean
}

export function contextFrom(inp: Inputs): Context {
  const r48 = inp.rain.filter(r => !r.forecast && r.t <= inp.now && r.t > inp.now - 48 * HR).reduce((a, r) => a + r.mm, 0)
  const f24 = inp.mode === 'live' ? inp.rain.filter(r => r.forecast && r.t > inp.now && r.t <= inp.now + 36 * HR).reduce((a, r) => a + r.mm, 0) : 0
  return { rain48: r48, rainFcst24: f24 }
}

export function runModel(M: ModelParams, inp: Inputs, coef = M.village): ModelRun {
  const F = forecast(M, inp), ctx = contextFrom(inp)
  const villages = M.villages.map(v => villageRisk(M, F, v, ctx, coef))
  const counts: ModelRun['counts'] = {}
  for (const h of HORIZONS) { const c = { LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 }; villages.forEach(v => c[v.levelAt[h]]++); counts[h] = c }
  const atRisk = villages.filter(v => v.level !== 'LOW').length
  const overall = villages.some(v => v.level === 'CRITICAL') ? 'CRITICAL' : villages.some(v => v.level === 'HIGH') ? 'HIGH' : atRisk > 0 ? 'MEDIUM' : 'LOW'
  const ups = F.slice(0, 3), river = ups.some(s => s.trend === 'Rising rapidly') ? 'Rising rapidly' : F.some(s => s.trend === 'Rising rapidly') ? 'Rising rapidly' : F.some(s => s.trend === 'Rising') ? 'Rising' : F.every(s => s.trend === 'Falling') ? 'Falling' : 'Steady'
  const rr = ctx.rain48 + ctx.rainFcst24
  const byType: Record<string, number> = {}
  inp.observations.forEach(o => { byType[o.type] = (byType[o.type] ?? 0) + 1 })
  return { at: new Date().toISOString(), now: inp.now, mode: inp.mode, version: M.version, stations: F, villages, counts, atRisk, overall, river, rainLevel: rr >= 80 ? 'HIGH' : rr >= 25 ? 'MODERATE' : 'LOW', ctx, inputs: { observations: inp.observations.length, byType }, rainMissing: !!inp.rainMissing }
}

/** Inputs for the clearly labelled demo: the September 2026 event replayed as if it were happening now. Only data up to the simulated clock is visible to the model. */
export function eventInputs(M: ModelParams, now: number, mode: Mode = 'demo'): Inputs {
  const t0 = Date.parse(M.event.start + 'T12:00:00Z')
  const stations = M.stations.map((_s, i) => ({ known: M.event.q[i].map((q, d) => ({ t: t0 + d * 864e5, q })) }))
  const rain = M.event.rain.map((mm, d) => ({ t: t0 + d * 864e5, mm, forecast: t0 + d * 864e5 > now }))
  const observations: Observation[] = []
  M.stations.forEach((s, i) => M.event.q[i].forEach((q, d) => { const t = t0 + d * 864e5; if (t <= now) observations.push({ ts: new Date(t).toISOString(), lat: s.glat, lng: s.glng, source: 'GloFAS v4 (2026 replay)', type: 'river_discharge', value: q, unit: 'm3/s', confidence: 'medium' }) }))
  M.event.rain.forEach((mm, d) => { const t = t0 + d * 864e5; if (t <= now) observations.push({ ts: new Date(t).toISOString(), lat: 27.9, lng: 83.9, source: 'Open-Meteo ERA5 (2026 replay)', type: 'rainfall', value: mm, unit: 'mm/day', confidence: 'medium' }) })
  return { now, mode, stations, rain, observations }
}
