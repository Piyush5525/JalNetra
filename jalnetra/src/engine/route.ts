// Evacuation routing over the terrain grid (~180 m cells). Moving along a mapped road is cheaper, rivers are
// never crossed, likely water (p >= 0.35) is only allowed for the first 3 km out of the village, possible water
// costs 3x. Dijkstra runs from the village until it reaches the first school or hospital that stays dry.
import type { Terrain } from './terrain'
const cellOf = (T: Terrain, lng: number, lat: number) => {
  const c = Math.floor((lng - T.w) / T.res), r = Math.floor((T.n - lat) / T.res)
  return c < 0 || r < 0 || c >= T.cols || r >= T.rows ? -1 : r * T.cols + c
}
const hav = (x1: number, y1: number, x2: number, y2: number) => {
  const r = Math.PI / 180, dl = (y2 - y1) * r, dn = (x2 - x1) * r
  const h = Math.sin(dl / 2) ** 2 + Math.cos(y1 * r) * Math.cos(y2 * r) * Math.sin(dn / 2) ** 2
  return 12742 * Math.asin(Math.sqrt(h))
}
type Graph = { road: Uint8Array; T: Terrain }
let G: Graph | null = null
/** Rasterise mapped roads onto the terrain grid. */
export function buildGraph(roads: { path: number[][] }[], T: Terrain): Graph {
  if (G && G.T === T) return G
  const road = new Uint8Array(T.cols * T.rows)
  for (const r of roads) for (let j = 1; j < r.path.length; j++) {
    const [x0, y0] = r.path[j - 1], [x1, y1] = r.path[j], n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / (T.res / 2)))
    for (let k = 0; k <= n; k++) { const c = cellOf(T, x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n); if (c >= 0) road[c] = 1 }
  }
  G = { road, T }; return G
}

class Heap { a: number[] = []; p: number[] = []
  push(v: number, pr: number) { const a = this.a, p = this.p; a.push(v); p.push(pr); let i = a.length - 1
    while (i > 0) { const j = (i - 1) >> 1; if (p[j] <= p[i]) break; [a[i], a[j]] = [a[j], a[i]]; [p[i], p[j]] = [p[j], p[i]]; i = j } }
  pop() { const a = this.a, p = this.p, v = a[0], last = a.length - 1; a[0] = a[last]; p[0] = p[last]; a.pop(); p.pop(); let i = 0
    for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < a.length && p[l] < p[m]) m = l; if (r < a.length && p[r] < p[m]) m = r; if (m === i) break; [a[i], a[m]] = [a[m], a[i]]; [p[i], p[m]] = [p[m], p[i]]; i = m }
    return v }
  get size() { return this.a.length } }

export type Poi = { n: string; a: string; x: number; y: number; h: number }
export type Route = {
  path: [number, number][]; km: number; roadKm: number; shelter: Poi; shelterKm: number
  wetKm: number; directKm: number | null; directWetKm: number | null; why: string; ok: boolean
  /** Same destination, but kept on mapped roads (a vehicle can use it) and out of predicted water. Null when no such way exists. */
  vehicle: { path: [number, number][]; km: number; roadKm: number; wetKm: number } | null
  /** The shortest way ignoring water, to the same destination. */
  shortest: { path: [number, number][]; km: number; wetKm: number } | null
}

const RAD = 30 // km search radius
function search(g: Graph, mask: Uint8Array, prob: Uint8Array, src: number, targets: Map<number, Poi>, safe: boolean, vehicle = false) {
  const T = g.T, C = T.cols, R = T.rows, cell = T.res * 111.32 * 0.893 // km per cell (cos 26.7)
  const r0 = (src / C) | 0, c0 = src - r0 * C, span = Math.ceil(RAD / cell)
  const dist = new Map<number, number>(), prev = new Map<number, number>(), along = new Map<number, number>()
  const h = new Heap(); dist.set(src, 0); along.set(src, 0); h.push(src, 0)
  const D8 = [[-1, 0, 1], [1, 0, 1], [0, -1, 1], [0, 1, 1], [-1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [1, 1, Math.SQRT2]]
  while (h.size) {
    const u = h.pop(), du = dist.get(u)!
    if (targets.has(u)) return { u, prev, dist }
    const ur = (u / C) | 0, uc = u - ur * C, au = along.get(u)!
    for (const [dr, dc, w] of D8) {
      const vr = ur + dr, vc = uc + dc
      if (vr < 0 || vc < 0 || vr >= R || vc >= C || Math.abs(vr - r0) > span || Math.abs(vc - c0) > span) continue
      const v = vr * C + vc, step = w * cell
      if (mask[v] === 2 && v !== src) continue // never across a river
      let f = g.road[v] && g.road[u] ? 0.5 : vehicle ? 8 : 1   // a vehicle stays on mapped roads; off-road hops are allowed only because they cost a lot
      if (safe) {
        const p = prob[v] / 255
        if (p >= 0.35) f *= au > 3 ? 12 : 6
        else if (mask[v] === 1) f *= 3
      }
      const nd = du + step * f
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, u); along.set(v, au + step); h.push(v, nd) }
    }
  }
  return null
}

/** mask: 0 dry, 1 predicted water, 2 river; prob: flood probability 0-255. */
export function evacuate(g: Graph, T: Terrain, mask: Uint8Array, prob: Uint8Array, pstar: number, v: { lng: number; lat: number }, pois: Poi[]): Route | null {
  const src = cellOf(T, v.lng, v.lat)
  if (src < 0) return null
  const targets = new Map<number, Poi>()
  for (const p of pois) {
    if (hav(v.lng, v.lat, p.x, p.y) > RAD) continue
    const c = cellOf(T, p.x, p.y)
    if (c < 0 || c === src || mask[c] !== 0 || prob[c] / 255 >= pstar * 0.6) continue
    if (!targets.has(c)) targets.set(c, p)
  }
  if (!targets.size) return null
  const C = T.cols, cell = T.res * 111.32 * 0.893
  const walk = (r: NonNullable<ReturnType<typeof search>>) => {
    const path: [number, number][] = []; let km = 0, wet = 0, poss = 0, roadKm = 0
    for (let u: number | undefined = r.u, last = -1; u !== undefined; last = u, u = r.prev.get(u)) {
      const rr = (u / C) | 0, cc = u - rr * C
      path.push([T.w + (cc + 0.5) * T.res, T.n - (rr + 0.5) * T.res])
      if (last >= 0) { const lr = (last / C) | 0, lc = last - lr * C, d = Math.hypot(lr - rr, lc - cc) * cell; km += d; if (prob[last] / 255 >= 0.35) wet += d; else if (mask[last] === 1) poss += d; if (g.road[last] && g.road[u]) roadKm += d }
    }
    path.push([v.lng, v.lat]); path.reverse()
    const sh = targets.get(r.u)!; path.push([sh.x, sh.y])
    return { path, km, wet, poss, roadKm, sh }
  }
  const s = search(g, mask, prob, src, targets, true)
  const d0 = search(g, mask, prob, src, targets, false)
  const d = d0 ? walk(d0) : null
  if (!s) return null
  const w = walk(s)
  // same destination for the two extra routes, so the three lines can be compared
  const wCell = [...targets.entries()].find(([, p]) => p === w.sh)?.[0]
  const only = wCell === undefined ? null : new Map<number, Poi>([[wCell, w.sh]])
  const vs = only ? search(g, mask, prob, src, only, true, true) : null
  const ds = only ? search(g, mask, prob, src, only, false) : null
  const vr = vs ? walk(vs) : null, sr = ds ? walk(ds) : null
  const vehicle = vr && vr.roadKm / Math.max(vr.km, 0.01) >= 0.5 && vr.wet <= 1.5 ? { path: vr.path, km: vr.km, roadKm: vr.roadKm, wetKm: vr.wet } : null
  const shortest = sr ? { path: sr.path, km: sr.km, wetKm: sr.wet } : null
  let why = `Nearest school or hospital that stays dry in the 24 h prediction, without crossing a river. ${Math.round((w.roadKm / Math.max(w.km, 0.01)) * 100)}% on mapped roads, the rest on open ground or village tracks.`
  if (d && d.wet > 0.2 && d.sh === w.sh && w.km > d.km + 0.2) why = `The shortest way (${d.km.toFixed(1)} km) runs through ${d.wet.toFixed(1)} km of likely flood water. This route avoids it (+${(w.km - d.km).toFixed(1)} km).`
  else if (d && d.sh !== w.sh) why = `The closest shelter (${d.sh.n}) can only be reached through predicted water, so JalNetra picked ${w.sh.n} instead.`
  const ok = w.wet <= 1.5
  if (!ok) why = `No dry way out: every route to a dry school or hospital passes ${w.wet.toFixed(1)} km of likely flood water. This is the least-exposed one. Leave before the water arrives.`
  else if (w.wet > 0.05) why += ` The first ${w.wet.toFixed(1)} km leaves the village through likely water: start early.`
  if (ok && w.poss > 0.3) why += ` ${w.poss.toFixed(1)} km crosses land that may flood (lower probability).`
  return { path: w.path, km: w.km, roadKm: w.roadKm, shelter: w.sh, shelterKm: hav(v.lng, v.lat, w.sh.x, w.sh.y), wetKm: w.wet, directKm: d?.km ?? null, directWetKm: d?.wet ?? null, ok, why, vehicle, shortest }
}

/** Roads and buildings inside predicted water. */
export function impactStats(g: Graph, mask: Uint8Array, roads: { path: number[][] }[], T: Terrain, pois: Poi[]) {
  let roadKm = 0, roadsHit = 0
  for (const r of roads) {
    let hit = false
    for (let j = 1; j < r.path.length; j++) {
      const c = cellOf(T, r.path[j][0], r.path[j][1])
      if (c >= 0 && mask[c] === 1) { hit = true; roadKm += hav(r.path[j - 1][0], r.path[j - 1][1], r.path[j][0], r.path[j][1]) }
    }
    if (hit) roadsHit++
  }
  const hit = pois.filter(p => { const c = cellOf(T, p.x, p.y); return c >= 0 && mask[c] === 1 })
  return { roadKm: Math.round(roadKm), roadsHit, schools: hit.filter(p => p.a !== 'h').length, hospitals: hit.filter(p => p.a === 'h').length, cells: g.road.length }
}
