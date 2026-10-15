import { metres, type SharedRoute } from './routeShare'

/**
 * A made-up flood placed next to wherever the user is standing, so the route and AR views can be tried anywhere (for example Noida,
 * where there is no river). It is not a prediction: a fictional east-west river sits ~190 m north of the user and its flood
 * footprint widens with time. The evacuation route leads away from it to the nearest school or hospital on the safe side, or to a
 * made-up high-ground point when no mapped place is found.
 */
export type LL = [number, number] // [lat, lng]
export type Sim = { user: LL; river: LL[]; route: SharedRoute; halfWidth: (hours: number) => number; shelterReal: boolean; riverGapM: number }

const M_PER_DEG = 111320
const toLL = (origin: LL, x: number, y: number): LL => [origin[0] + y / M_PER_DEG, origin[1] + x / (M_PER_DEG * Math.cos((origin[0] * Math.PI) / 180))]
const toXY = (origin: LL, p: LL): [number, number] => [(p[1] - origin[1]) * M_PER_DEG * Math.cos((origin[0] * Math.PI) / 180), (p[0] - origin[0]) * M_PER_DEG]

/** Metres of flood half-width around the river after `hours`: 60 m now, spreading ~70 m per hour. */
export const halfWidthAt = (hours: number) => 60 + 70 * Math.max(0, hours)

export function buildSim(user: LL, shelter?: { n: string; lat: number; lng: number } | null): Sim {
  const GAP = 190
  const river: LL[] = Array.from({ length: 31 }, (_, i) => { const x = -1500 + i * 100; return toLL(user, x, GAP + 40 * Math.sin(x / 450)) })
  // only take a mapped place that is on the safe (south) side of the river and a sensible walk away
  let place = shelter ?? null
  if (place) {
    const [sx, sy] = toXY(user, [place.lat, place.lng])
    const d = Math.hypot(sx, sy)
    if (sy > -120 || d < 250 || d > 1800) place = null
  }
  const shelterLL: LL = place ? [place.lat, place.lng] : toLL(user, 140, -650)
  const mid = toLL(user, toXY(user, shelterLL)[0] * 0.35, toXY(user, shelterLL)[1] * 0.55)
  const pathLL: LL[] = [user, mid, shelterLL]
  const km = pathLL.slice(1).reduce((acc, p, i) => acc + metres(pathLL[i], p), 0) / 1000
  const route: SharedRoute = {
    v: 'Your location (simulation)', d: undefined, lvl: 'CRITICAL', when: `in ${fmtHours(hoursUntil(distanceToRiver(user, river)))}`, at: new Date().toISOString(),
    from: user, to: shelterLL, shelter: place ? place.n : 'Safe high ground (simulated)', km, path: pathLL.map(([lat, lng]) => [lng, lat] as [number, number]), ex: true,
  }
  return { user, river, route, halfWidth: halfWidthAt, shelterReal: !!place, riverGapM: GAP }
}

/** Polygon ([lng, lat] ring) of the flooded strip around the river for a given half-width in metres. */
export function floodRing(river: LL[], originLat: number, halfWidthM: number): [number, number][] {
  const dLat = halfWidthM / M_PER_DEG
  const top = river.map(([lat, lng]) => [lng, lat + dLat] as [number, number])
  const bottom = river.map(([lat, lng]) => [lng, lat - dLat] as [number, number]).reverse()
  void originLat
  return [...top, ...bottom, top[0]]
}

/** Distance in metres from a point to the nearest river vertex (the river is densely sampled). */
export const distanceToRiver = (p: LL, river: LL[]) => Math.min(...river.map(r => metres(p, r)))

/** Hours until the flood strip's edge reaches distance `d` (metres) from the river centre line, or null if not within 12 h. */
export function hoursUntil(d: number): number | null {
  if (halfWidthAt(0) >= d) return 0
  const h = (d - 60) / 70
  return h <= 12 ? h : null
}
export const fmtHours = (h: number | null) => (h === null ? 'not within 12 h' : h < 0.05 ? 'now' : h < 1 ? `${Math.round(h * 60)} min` : `${Math.floor(h)} h ${Math.round((h - Math.floor(h)) * 60)} min`)

/** Look for a school or hospital within 1.5 km using OpenStreetMap (Overpass). Resolves null if unavailable; the simulation has a fallback. */
export async function nearbyShelter(user: LL, signal?: AbortSignal): Promise<{ n: string; lat: number; lng: number } | null> {
  const q = `[out:json][timeout:8];(node["amenity"~"school|hospital|college"]["name"](around:1500,${user[0]},${user[1]});way["amenity"~"school|hospital|college"]["name"](around:1500,${user[0]},${user[1]}););out center 20;`
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), signal })
    if (!res.ok) return null
    const data = await res.json() as { elements?: { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: { name?: string } }[] }
    const items = (data.elements ?? []).map(e => ({ n: e.tags?.name ?? '', lat: e.lat ?? e.center?.lat ?? NaN, lng: e.lon ?? e.center?.lon ?? NaN })).filter(e => e.n && Number.isFinite(e.lat) && Number.isFinite(e.lng))
    // prefer the ones on the safe side, nearest first
    const safe = items.filter(i => { const [x, y] = toXY(user, [i.lat, i.lng]); return y < -120 && Math.hypot(x, y) >= 250 })
    safe.sort((a, b) => metres(user, [a.lat, a.lng]) - metres(user, [b.lat, b.lng]))
    return safe[0] ?? null
  } catch { return null }
}

export { toXY }
