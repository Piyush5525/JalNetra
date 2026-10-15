import { HORIZONS, eventInputs, runModel, type ModelRun } from '../engine/core'
import { extentAt, type Extent, type Terrain } from '../engine/terrain'
import { M } from '../live/shared'
import { connectedSpread, type SpreadSummary } from './connectivity'

export type Horizon = (typeof HORIZONS)[number]
export type SpreadResult = { extent: Extent; mask: Uint8Array; summary: SpreadSummary; terrain: Terrain; run: ModelRun }

const DAY = 86400e3

/**
 * The browser-side spread view is intentionally a replay of the bundled event.
 * It is not a current hydraulic forecast and must never drive an alert.
 */
export const replayDate = () => {
  const radar = M.obsTimes?.o2 ? Date.parse(M.obsTimes.o2) : NaN
  return Number.isFinite(radar) ? radar : Date.parse(M.event.start + 'T12:00:00Z') + 14 * DAY
}

const resultCache = new WeakMap<Terrain, Map<Horizon, SpreadResult>>()

export const makeSpreadResult = (terrain: Terrain, horizon: Horizon): SpreadResult => {
  const cached = resultCache.get(terrain)?.get(horizon)
  if (cached) return cached
  const run = runModel(M, eventInputs(M, replayDate(), 'demo'))
  const extent = extentAt(M, terrain, run.stations, horizon, 'predicted')
  const spread = connectedSpread({ mask: extent.mask, prob: extent.prob, cols: terrain.cols, rows: terrain.rows, hand: terrain.hand, res: terrain.res })
  const result = { terrain, extent, mask: spread.mask, summary: spread.summary, run }
  const byHorizon = resultCache.get(terrain) ?? new Map<Horizon, SpreadResult>()
  byHorizon.set(horizon, result)
  resultCache.set(terrain, byHorizon)
  return result
}

/** Render the model mask as a transparent raster suitable for a map bitmap layer. */
export const spreadImage = (result: SpreadResult) => {
  const pixels = new ImageData(result.terrain.cols, result.terrain.rows)
  for (let i = 0; i < result.mask.length; i++) {
    const mask = result.mask[i]
    if (mask === 0) continue
    const alpha = mask === 2 ? 205 : Math.min(220, 65 + Math.round((result.extent.prob[i] / 255) * 155))
    const p = i * 4
    pixels.data[p] = mask === 2 ? 17 : 14
    pixels.data[p + 1] = mask === 2 ? 122 : 165
    pixels.data[p + 2] = mask === 2 ? 176 : 232
    pixels.data[p + 3] = alpha
  }
  return pixels
}
