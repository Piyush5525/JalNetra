import { HORIZONS, type ModelRun } from '../engine/core'
import { extentAt, type Terrain } from '../engine/terrain'
import { M } from '../live/shared'
import { connectedSpread } from './connectivity'

/**
 * Town-level flood spread and impact zone.
 *
 * The discharge forecast of a model run (live, or the bundled September 2026 replay) is turned into a per-cell flood
 * probability by the fitted pixel model, only cells connected to the river are kept, and the normal channel is
 * subtracted. The impact zone of a town is the flooded land along the river reach that affects it: the cells whose
 * river chainage lies within REACH_HALF_KM upstream or downstream of the village, out to the natural edge of the flood.
 */

/** Replay clock: the flood front is still upstream (dry at the towns now), and reaches all five within 24 h. */
export const SPREAD_CLOCK = '2026-09-27T12:00:00Z'
/** Half-length, along the river, of the reach whose flooded land forms a town's impact zone. */
export const REACH_HALF_KM = 8
/** The flood "reaches" a town when connected water is within this distance of the village point. */
export const REACH_KM = 1
/** Hours (hourly to 12 h, then every 3 h) at which the arrival time is evaluated. */
const ARRIVAL_HOURS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 18, 21, 24]
const KM_PER_DEG = 111.32

export type SpreadHorizon = (typeof HORIZONS)[number]
export type Town = { id: number; lat: number; lng: number; /** km below Devghat along the river */ ch: number }

export type TownSpreadModel = {
  run: ModelRun
  /** Connected-spread mask per horizon: 0 dry, 1 extra flood water, 2 normal river. */
  masks: Record<number, Uint8Array>
  /** Flood probability (0-255) per horizon. */
  probs: Record<number, Uint8Array>
  /** Water NOW ∪ +24 h, for evacuation routing. */
  routeMask: { m: Uint8Array; p: Uint8Array }
  /** First whole hour (within 24 h) at which connected water is within REACH_KM of the town. */
  arrival: Map<number, number | null>
}

export type TownFacts = {
  horizon: number
  /** Length of river reach the zone covers, km. */
  reachKm: number
  /** Normal river (JRC permanent water) inside the reach. */
  normalKm2: number
  /** Extra land under predicted flood water inside the reach. */
  extraKm2: number
  /** Extra land added since NOW. */
  growthKm2: number
  /** Share of land cells within 2 km of the village that are under predicted water. */
  share2km: number
  /** Village point is within REACH_KM of connected flood water. */
  reached: boolean
  /** Distance from the village to the nearest normal river cell, km. */
  riverKm: number | null
  /** Distance from the village to the nearest predicted flood water, km. */
  waterKm: number | null
  /** Highest ground (m above channel) the water reaches inside the reach. */
  maxHandM: number | null
  /** Mean flood probability of the flooded cells, 0-1. */
  meanProb: number | null
  arrivalH: number | null
}

const cache = new WeakMap<ModelRun, TownSpreadModel>()

export function buildTownSpread(terrain: Terrain, towns: Town[], run: ModelRun): TownSpreadModel {
  const hit = cache.get(run)
  if (hit) return hit
  const { cols, rows } = terrain
  const masks: Record<number, Uint8Array> = {}, probs: Record<number, Uint8Array> = {}
  const arrival = new Map<number, number | null>(towns.map(t => [t.id, null]))
  const reach = Math.ceil(REACH_KM / (terrain.res * KM_PER_DEG))
  const cells = towns.map(t => ({ id: t.id, c: Math.floor((t.lng - terrain.w) / terrain.res), r: Math.floor((terrain.n - t.lat) / terrain.res) }))
  const wanted = new Set<number>([...HORIZONS, ...ARRIVAL_HOURS])
  for (const h of [...wanted].sort((a, b) => a - b)) {
    const e = extentAt(M, terrain, run.stations, h, 'none')
    const s = connectedSpread({ mask: e.mask, prob: e.prob, cols, rows, hand: terrain.hand, res: terrain.res })
    if ((HORIZONS as readonly number[]).includes(h)) { masks[h] = s.mask; probs[h] = e.prob }
    for (const t of cells) {
      if (arrival.get(t.id) !== null) continue
      let wet = false
      for (let dr = -reach; dr <= reach && !wet; dr++) for (let dc = -reach; dc <= reach; dc++) {
        const r = t.r + dr, c = t.c + dc
        if (r >= 0 && c >= 0 && r < rows && c < cols && s.mask[r * cols + c] === 1) { wet = true; break }
      }
      if (wet) arrival.set(t.id, h)
    }
  }
  const a = masks[0], b = masks[24], m = new Uint8Array(a.length), p = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) { m[i] = a[i] === 2 || b[i] === 2 ? 2 : a[i] || b[i] ? 1 : 0; p[i] = Math.max(probs[0][i], probs[24][i]) }
  const model: TownSpreadModel = { run, masks, probs, routeMask: { m, p }, arrival }
  cache.set(run, model)
  return model
}

export type Reach = {
  kmLat: number; kmLng: number
  /** Village cell. */
  vc: number; vr: number
  /** Bounding box of the reach (inclusive-exclusive). */
  c0: number; c1: number; r0: number; r1: number
  /** True when cell i lies on the river reach that affects the town. */
  has: (i: number) => boolean
}
const reachCache = new WeakMap<Terrain, Map<string, Reach>>()

/** The river reach (cells within REACH_HALF_KM of the village chainage) and its bounding box. */
export function windowOf(terrain: Terrain, town: Town): Reach {
  let byTown = reachCache.get(terrain)
  if (!byTown) { byTown = new Map(); reachCache.set(terrain, byTown) }
  const key = `${town.id}:${town.ch}`
  const hit = byTown.get(key)
  if (hit) return hit
  const kmLat = terrain.res * KM_PER_DEG, kmLng = kmLat * Math.cos((town.lat * Math.PI) / 180)
  const has = (i: number) => terrain.code[i] !== 255 && Math.abs(terrain.ch[i] * 2 - town.ch) <= REACH_HALF_KM
  let c0 = terrain.cols, c1 = 0, r0 = terrain.rows, r1 = 0
  for (let r = 0; r < terrain.rows; r++) for (let c = 0; c < terrain.cols; c++) {
    if (!has(r * terrain.cols + c)) continue
    if (c < c0) c0 = c
    if (c >= c1) c1 = c + 1
    if (r < r0) r0 = r
    if (r >= r1) r1 = r + 1
  }
  const reach: Reach = {
    kmLat, kmLng, has,
    vc: Math.floor((town.lng - terrain.w) / terrain.res), vr: Math.floor((terrain.n - town.lat) / terrain.res),
    c0: Math.min(c0, c1), c1, r0: Math.min(r0, r1), r1,
  }
  byTown.set(key, reach)
  return reach
}

export function townFacts(model: TownSpreadModel, terrain: Terrain, town: Town, h: number): TownFacts {
  const w = windowOf(terrain, town), mask = model.masks[h] ?? model.masks[0], now = model.masks[0], prob = model.probs[h] ?? model.probs[0]
  const area = w.kmLat * w.kmLng
  let normal = 0, extra = 0, extraNow = 0, land2 = 0, wet2 = 0, riverKm = Infinity, waterKm = Infinity, maxHand = -Infinity, probSum = 0
  for (let r = w.r0; r < w.r1; r++) for (let c = w.c0; c < w.c1; c++) {
    const i = r * terrain.cols + c
    if (!w.has(i)) continue
    const dist = Math.hypot((c - w.vc) * w.kmLng, (r - w.vr) * w.kmLat)
    const m = mask[i]
    if (m === 2) { normal++; riverKm = Math.min(riverKm, dist) }
    else {
      if (dist <= 2) land2++
      if (m === 1) {
        extra++; waterKm = Math.min(waterKm, dist); probSum += prob[i]
        maxHand = Math.max(maxHand, terrain.hand[i])
        if (dist <= 2) wet2++
      }
    }
    if (now[i] === 1) extraNow++
  }
  return {
    horizon: h, reachKm: REACH_HALF_KM * 2,
    normalKm2: Math.round(normal * area * 10) / 10, extraKm2: Math.round(extra * area * 10) / 10, growthKm2: Math.round(Math.max(0, extra - extraNow) * area * 10) / 10,
    share2km: land2 ? wet2 / land2 : 0, reached: waterKm <= REACH_KM,
    riverKm: Number.isFinite(riverKm) ? Math.round(riverKm * 10) / 10 : null, waterKm: Number.isFinite(waterKm) ? Math.round(waterKm * 10) / 10 : null,
    maxHandM: Number.isFinite(maxHand) ? Math.round(maxHand * 10) / 10 : null, meanProb: extra ? probSum / extra / 255 : null,
    arrivalH: model.arrival.get(town.id) ?? null,
  }
}

const NORMAL: [number, number, number, number] = [37, 99, 235, 235]

/** Image of the reach around a town showing the normal river channel in blue. */
export function townImage(model: TownSpreadModel, terrain: Terrain, town: Town, h: number) {
  const w = windowOf(terrain, town), mask = model.masks[h] ?? model.masks[0]
  const W = Math.max(1, w.c1 - w.c0), Hh = Math.max(1, w.r1 - w.r0), img = new ImageData(W, Hh)
  for (let r = w.r0; r < w.r1; r++) for (let c = w.c0; c < w.c1; c++) {
    const i = r * terrain.cols + c
    if (mask[i] !== 2 || !w.has(i)) continue   // the flood itself is drawn as a polygon; this image is only the normal river channel
    const p = ((r - w.r0) * W + (c - w.c0)) * 4
    img.data[p] = NORMAL[0]; img.data[p + 1] = NORMAL[1]; img.data[p + 2] = NORMAL[2]; img.data[p + 3] = NORMAL[3]
  }
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = Hh
  canvas.getContext('2d')!.putImageData(img, 0, 0)
  const bounds: [number, number, number, number] = [terrain.w + w.c0 * terrain.res, terrain.n - w.r1 * terrain.res, terrain.w + w.c1 * terrain.res, terrain.n - w.r0 * terrain.res]
  return { canvas, bounds }
}
