import { HORIZONS, eventInputs, runModel, type ModelRun } from '../engine/core'
import { extentAt, type Terrain } from '../engine/terrain'
import { M } from '../live/shared'
import { connectedSpread } from './connectivity'

/**
 * Town-level flood spread for the five exercise villages.
 *
 * The browser replays the September 2026 Gandak flood at a fixed clock, turns the discharge forecast into
 * a per-cell flood probability (the same fitted pixel model the rest of the app uses), keeps only the wet
 * cells that are connected to the river, and compares them with the normal channel. The difference is the
 * "extra area" a flooded river covers. It is a replay of a past event, never a live forecast.
 */

/** Replay clock: the flood front is still upstream (dry at the towns now), and reaches all five within 24 h. */
export const SPREAD_CLOCK = '2026-09-27T12:00:00Z'
/** Window around the town that is analysed and drawn. */
export const SPREAD_RADIUS_KM = 12
/** The flood "reaches" a town when connected water is within this distance of the village point. */
export const REACH_KM = 1
/** Hours (hourly to 12 h, then every 3 h) at which the arrival time is evaluated. */
const ARRIVAL_HOURS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 18, 21, 24]
const KM_PER_DEG = 111.32

export type SpreadHorizon = (typeof HORIZONS)[number]
type Town = { id: number; lat: number; lng: number }

export type TownSpreadModel = {
  clock: string
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
  radiusKm: number
  /** Normal river (JRC permanent water) inside the window. */
  normalKm2: number
  /** Extra land under predicted flood water inside the window. */
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
  /** Highest ground (m above channel) the water reaches inside the window. */
  maxHandM: number | null
  /** Mean flood probability of the flooded cells, 0-1. */
  meanProb: number | null
  arrivalH: number | null
}

const cache = new WeakMap<Terrain, TownSpreadModel>()

export function buildTownSpread(terrain: Terrain, towns: Town[]): TownSpreadModel {
  const hit = cache.get(terrain)
  if (hit) return hit
  const run = runModel(M, eventInputs(M, Date.parse(SPREAD_CLOCK), 'demo'))
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
  const model = { clock: SPREAD_CLOCK, run, masks, probs, routeMask: { m, p }, arrival }
  cache.set(terrain, model)
  return model
}

/** Pixel window (inclusive-exclusive) around a town and its km-per-cell scale. */
function windowOf(terrain: Terrain, town: Town) {
  const kmLat = terrain.res * KM_PER_DEG, kmLng = kmLat * Math.cos((town.lat * Math.PI) / 180)
  const half = Math.ceil(SPREAD_RADIUS_KM / kmLat)
  const vc = Math.floor((town.lng - terrain.w) / terrain.res), vr = Math.floor((terrain.n - town.lat) / terrain.res)
  return { kmLat, kmLng, vc, vr, c0: Math.max(0, vc - half), c1: Math.min(terrain.cols, vc + half + 1), r0: Math.max(0, vr - half), r1: Math.min(terrain.rows, vr + half + 1) }
}

export function townFacts(model: TownSpreadModel, terrain: Terrain, town: Town, h: number): TownFacts {
  const w = windowOf(terrain, town), mask = model.masks[h] ?? model.masks[0], now = model.masks[0], prob = model.probs[h] ?? model.probs[0]
  const area = w.kmLat * w.kmLng
  let normal = 0, extra = 0, extraNow = 0, land2 = 0, wet2 = 0, riverKm = Infinity, waterKm = Infinity, maxHand = -Infinity, probSum = 0
  for (let r = w.r0; r < w.r1; r++) for (let c = w.c0; c < w.c1; c++) {
    const i = r * terrain.cols + c
    const dist = Math.hypot((c - w.vc) * w.kmLng, (r - w.vr) * w.kmLat)
    if (dist > SPREAD_RADIUS_KM || terrain.code[i] === 255) continue
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
    horizon: h, radiusKm: SPREAD_RADIUS_KM,
    normalKm2: Math.round(normal * area * 10) / 10, extraKm2: Math.round(extra * area * 10) / 10, growthKm2: Math.round(Math.max(0, extra - extraNow) * area * 10) / 10,
    share2km: land2 ? wet2 / land2 : 0, reached: waterKm <= REACH_KM,
    riverKm: Number.isFinite(riverKm) ? Math.round(riverKm * 10) / 10 : null, waterKm: Number.isFinite(waterKm) ? Math.round(waterKm * 10) / 10 : null,
    maxHandM: Number.isFinite(maxHand) ? Math.round(maxHand * 10) / 10 : null, meanProb: extra ? probSum / extra / 255 : null,
    arrivalH: model.arrival.get(town.id) ?? null,
  }
}

const NORMAL: [number, number, number, number] = [37, 99, 235, 235]
const EXTRA_NOW: [number, number, number, number] = [251, 146, 60, 185]
const EXTRA_NEW: [number, number, number, number] = [220, 38, 38, 205]
const EDGE: [number, number, number, number] = [127, 29, 29, 255]

/** Image of the window around a town: normal river in blue, extra flood water in orange, water new since NOW in red. */
export function townImage(model: TownSpreadModel, terrain: Terrain, town: Town, h: number) {
  const w = windowOf(terrain, town), mask = model.masks[h] ?? model.masks[0], now = model.masks[0]
  const W = w.c1 - w.c0, Hh = w.r1 - w.r0, img = new ImageData(W, Hh)
  for (let r = w.r0; r < w.r1; r++) for (let c = w.c0; c < w.c1; c++) {
    const i = r * terrain.cols + c, m = mask[i]
    if (m === 0 || terrain.code[i] === 255) continue
    if (Math.hypot((c - w.vc) * w.kmLng, (r - w.vr) * w.kmLat) > SPREAD_RADIUS_KM) continue
    let col = NORMAL
    if (m === 1) {
      col = h === 0 || now[i] === 1 ? EXTRA_NOW : EXTRA_NEW
      const edge = (c > 0 && mask[i - 1] === 0) || (c < terrain.cols - 1 && mask[i + 1] === 0) || (r > 0 && mask[i - terrain.cols] === 0) || (r < terrain.rows - 1 && mask[i + terrain.cols] === 0)
      if (edge) col = EDGE
    }
    const p = ((r - w.r0) * W + (c - w.c0)) * 4
    img.data[p] = col[0]; img.data[p + 1] = col[1]; img.data[p + 2] = col[2]; img.data[p + 3] = col[3]
  }
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = Hh
  canvas.getContext('2d')!.putImageData(img, 0, 0)
  const bounds: [number, number, number, number] = [terrain.w + w.c0 * terrain.res, terrain.n - w.r1 * terrain.res, terrain.w + w.c1 * terrain.res, terrain.n - w.r0 * terrain.res]
  return { canvas, bounds }
}
