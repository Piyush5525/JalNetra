import type { Terrain } from '../engine/terrain'
import { windowOf, type Town, type TownSpreadModel } from './townSpread'

/**
 * Flood-zone polygon for one town.
 *
 * The polygon is the outline of the connected flood water along the river reach that affects the town, at a forecast
 * horizon. Its shape comes from the flood itself (terrain, discharge, connectivity), not from a fixed radius.
 */

/** Holes in the flooded area smaller than this many cells are filled before the outline is drawn. */
const MIN_HOLE_CELLS = 60
/** The evacuation zone is the flood at this horizon and the next forecast step, widened by this many cells (about 0.2 km each). */
export const EVAC_BUFFER_CELLS = 3
/** Islands smaller than this many cells are dropped from the outline. */
const MIN_ISLAND_CELLS = 8

type Pt = [number, number]
export type ZoneKind = 'flood' | 'evac'
export type Ring = Pt[]
/** One polygon = outer ring first, then holes. Coordinates are [lng, lat]. */
export type ZonePolygon = Ring[]
export type Zone = {
  horizon: number
  polygons: ZonePolygon[]
  areaKm2: number
  centroid: Pt | null
  /** True when a lng/lat falls inside the (hole-filled) flood zone. */
  contains: (lng: number, lat: number) => boolean
}
export type Device = { id: number; lng: number; lat: number; km: number }

const zoneCache = new WeakMap<TownSpreadModel, Map<string, Zone>>()

function perpDist(p: Pt, a: Pt, b: Pt) {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy
  if (!len) return Math.hypot(p[0] - a[0], p[1] - a[1])
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}
function simplify(pts: Pt[], tol: number): Pt[] {
  if (pts.length < 3) return pts
  let maxD = 0, idx = 0
  for (let i = 1; i < pts.length - 1; i++) { const d = perpDist(pts[i], pts[0], pts[pts.length - 1]); if (d > maxD) { maxD = d; idx = i } }
  if (maxD <= tol) return [pts[0], pts[pts.length - 1]]
  return [...simplify(pts.slice(0, idx + 1), tol).slice(0, -1), ...simplify(pts.slice(idx), tol)]
}
function chaikin(r: Pt[]): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length]
    out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25], [a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75])
  }
  return out
}
function signedArea(r: Pt[]) {
  let s = 0
  for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1] }
  return s
}
function inRing(x: number, y: number, r: Pt[]) {
  let inside = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > y) !== (r[j][1] > y) && x < ((r[j][0] - r[i][0]) * (y - r[i][1])) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside
  }
  return inside
}

/** Outline of the connected flood water along the river reach that affects a town, for one horizon. */
export function townZone(model: TownSpreadModel, terrain: Terrain, town: Town, h: number, kind: ZoneKind = 'flood'): Zone {
  const key = `${town.id}:${h}:${kind}`
  let byKey = zoneCache.get(model)
  if (!byKey) { byKey = new Map(); zoneCache.set(model, byKey) }
  const hit = byKey.get(key)
  if (hit) return hit

  const w = windowOf(terrain, town), mask = model.masks[h] ?? model.masks[0]
  const W = Math.max(1, w.c1 - w.c0), Hh = Math.max(1, w.r1 - w.r0)
  // the evacuation zone also covers what the flood reaches by the next forecast step, so people are out before the water arrives
  const steps = Object.keys(model.masks).map(Number).sort((a, b) => a - b)
  const ahead = kind === 'evac' ? model.masks[steps[Math.min(steps.length - 1, steps.indexOf(h) + 1)]] : null
  const g = new Uint8Array(W * Hh)
  for (let r = w.r0; r < w.r1; r++) for (let c = w.c0; c < w.c1; c++) {
    const i = r * terrain.cols + c
    if (!w.has(i)) continue
    if (mask[i] === 1 || (ahead && ahead[i] === 1)) g[(r - w.r0) * W + (c - w.c0)] = 1
  }
  if (kind === 'evac') {
    // safety margin: widen by a few cells (diamond), staying inside the river reach
    const src = g.slice()
    for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
      if (!src[y * W + x]) continue
      for (let dy = -EVAC_BUFFER_CELLS; dy <= EVAC_BUFFER_CELLS; dy++) for (let dx = -EVAC_BUFFER_CELLS; dx <= EVAC_BUFFER_CELLS; dx++) {
        if (Math.abs(dx) + Math.abs(dy) > EVAC_BUFFER_CELLS) continue
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= W || ny >= Hh) continue
        if (w.has((w.r0 + ny) * terrain.cols + (w.c0 + nx))) g[ny * W + nx] = 1
      }
    }
  }

  // fill small holes: dry cells that cannot reach the window border through other dry cells, and are few
  const seen = new Uint8Array(W * Hh), q: number[] = []
  const push = (i: number) => { if (!g[i] && !seen[i]) { seen[i] = 1; q.push(i) } }
  for (let x = 0; x < W; x++) { push(x); push((Hh - 1) * W + x) }
  for (let y = 0; y < Hh; y++) { push(y * W); push(y * W + W - 1) }
  for (let k = 0; k < q.length; k++) {
    const i = q[k], y = (i / W) | 0, x = i - y * W
    if (x > 0) push(i - 1)
    if (x < W - 1) push(i + 1)
    if (y > 0) push(i - W)
    if (y < Hh - 1) push(i + W)
  }
  const done = new Uint8Array(W * Hh)
  for (let s = 0; s < W * Hh; s++) {
    if (g[s] || seen[s] || done[s]) continue
    const comp: number[] = [s]
    done[s] = 1
    for (let k = 0; k < comp.length; k++) {
      const i = comp[k], y = (i / W) | 0, x = i - y * W
      for (const n of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < Hh - 1 ? i + W : -1]) {
        if (n >= 0 && !g[n] && !seen[n] && !done[n]) { done[n] = 1; comp.push(n) }
      }
    }
    if (comp.length < MIN_HOLE_CELLS) for (const i of comp) g[i] = 1
  }
  let cells = 0, sx = 0, sy = 0
  for (let i = 0; i < g.length; i++) if (g[i]) { cells++; sx += i % W; sy += (i / W) | 0 }

  // boundary edges between flooded and dry cells (interior on one side), linked into closed rings
  const next = new Map<number, number[]>(), V = W + 1
  const edge = (ax: number, ay: number, bx: number, by: number) => {
    const k = ay * V + ax, v = by * V + bx, l = next.get(k)
    if (l) l.push(v); else next.set(k, [v])
  }
  for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) {
    if (!g[y * W + x]) continue
    if (y === 0 || !g[(y - 1) * W + x]) edge(x, y, x + 1, y)
    if (x === W - 1 || !g[y * W + x + 1]) edge(x + 1, y, x + 1, y + 1)
    if (y === Hh - 1 || !g[(y + 1) * W + x]) edge(x + 1, y + 1, x, y + 1)
    if (x === 0 || !g[y * W + x - 1]) edge(x, y + 1, x, y)
  }
  const vertex = (v: number): Pt => { const y = (v / V) | 0; return [v - y * V, y] }
  const rings: Pt[][] = []
  for (const start of [...next.keys()]) {
    while (next.get(start)?.length) {
      const ring: Pt[] = [vertex(start)]
      let cur = start
      for (;;) {
        const l = next.get(cur)
        if (!l?.length) break
        const n = l.pop()!
        if (n === start) break
        ring.push(vertex(n))
        cur = n
      }
      if (ring.length >= 4) rings.push(ring)
    }
  }

  const toGeo = (r: Pt[]): Ring => r.map(([x, y]) => [terrain.w + (w.c0 + x) * terrain.res, terrain.n - (w.r0 + y) * terrain.res] as Pt)
  const kept = rings.map(r => ({ r, a: signedArea(r) })).filter(o => Math.abs(o.a) / 2 >= MIN_ISLAND_CELLS)
  const outerSign = kept.length ? Math.sign(kept.reduce((m, o) => (Math.abs(o.a) > Math.abs(m.a) ? o : m)).a) : 1
  const smooth = (r: Pt[]) => chaikin(simplify([...r, r[0]], 0.7).slice(0, -1))
  const polys = kept.filter(o => Math.sign(o.a) === outerSign).map(o => ({ o, ring: smooth(o.r), holes: [] as Pt[][] }))
  for (const hl of kept.filter(o => Math.sign(o.a) !== outerSign)) {
    const p = hl.r[0]
    const owner = polys.filter(pl => inRing(p[0], p[1], pl.o.r)).sort((a, b) => Math.abs(a.o.a) - Math.abs(b.o.a))[0]
    if (owner) owner.holes.push(smooth(hl.r))
  }
  const cellKm2 = w.kmLat * w.kmLng
  const zone: Zone = {
    horizon: h,
    polygons: polys.map(pl => [toGeo(pl.ring), ...pl.holes.map(toGeo)]),
    areaKm2: Math.round(cells * cellKm2 * 10) / 10,
    centroid: cells ? [terrain.w + (w.c0 + sx / cells + 0.5) * terrain.res, terrain.n - (w.r0 + sy / cells + 0.5) * terrain.res] : null,
    contains: (lng, lat) => {
      const c = Math.floor((lng - terrain.w) / terrain.res) - w.c0, r = Math.floor((terrain.n - lat) / terrain.res) - w.r0
      return c >= 0 && r >= 0 && c < W && r < Hh && g[r * W + c] === 1
    },
  }
  byKey.set(key, zone)
  return zone
}


/** Reduce a ring to at most `max` vertices (Douglas-Peucker with a growing tolerance). */
export function limitRing(ring: Ring, max: number): Ring {
  let tol = 1e-4, out = simplify([...ring, ring[0]], tol).slice(0, -1)
  while (out.length > max && tol < 1) { tol *= 1.6; out = simplify([...ring, ring[0]], tol).slice(0, -1) }
  return out
}

const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/**
 * Where to draw phone icons for an estimated phone count: around the mapped villages that fall inside the zone, or
 * spread over the zone if none do. The count is an estimate; icon positions are illustrative.
 */
export function placePhones(zone: Zone, anchors: Pt[], icons: number, seed: number): Pt[] {
  if (!zone.polygons.length || icons <= 0) return []
  const rand = rng(seed), out: Pt[] = []
  const inside = anchors.filter(a => zone.contains(a[0], a[1]))
  const lngs = zone.polygons.flatMap(p => p[0].map(v => v[0])), lats = zone.polygons.flatMap(p => p[0].map(v => v[1]))
  const x0 = Math.min(...lngs), x1 = Math.max(...lngs), y0 = Math.min(...lats), y1 = Math.max(...lats)
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())
  for (let tries = 0; out.length < icons && tries < icons * 40; tries++) {
    let p: Pt
    if (inside.length && rand() < 0.85) {
      const a = inside[Math.floor(rand() * inside.length)]
      p = [a[0] + gauss() * 0.004, a[1] + gauss() * 0.004]   // about 0.4 km around the village
    } else p = [x0 + rand() * (x1 - x0), y0 + rand() * (y1 - y0)]
    if (zone.contains(p[0], p[1])) out.push(p)
  }
  return out
}
