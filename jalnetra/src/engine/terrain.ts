// Browser side of the engine: decodes the terrain grid (height above channel, chainage, distance to river)
// and turns a discharge forecast into a predicted inundation raster for one horizon.
import terrainUrl from '../img/terrain.png'
import { pixelP, qEffTable, type ModelParams, type StationForecast } from './core'

export type Terrain = { cols: number; rows: number; w: number; n: number; res: number; hand: Float32Array; ch: Uint8Array; dk: Float32Array; code: Uint8Array }
let cache: Promise<Terrain> | null = null

export function loadTerrain(M: ModelParams & { grid: { w: number; n: number; res: number; cols: number; rows: number } }): Promise<Terrain> {
  if (cache) return cache
  cache = (async () => {
    const blob = await (await fetch(terrainUrl)).blob()
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height
    const ctx = c.getContext('2d', { willReadFrequently: true })!; ctx.drawImage(bmp, 0, 0)
    const px = ctx.getImageData(0, 0, c.width, c.height).data
    const n = c.width * c.height, hand = new Float32Array(n), ch = new Uint8Array(n), dk = new Float32Array(n), code = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      const r = px[i * 4]; code[i] = r >= 254 ? r : 0
      hand[i] = r / 10 - 5; ch[i] = px[i * 4 + 1]; dk[i] = px[i * 4 + 2] / 10
    }
    return { cols: c.width, rows: c.height, w: M.grid.w, n: M.grid.n, res: M.grid.res, hand, ch, dk, code }
  })()
  return cache
}

export const cellOf = (T: Terrain, lng: number, lat: number) => {
  const c = Math.floor((lng - T.w) / T.res), r = Math.floor((T.n - lat) / T.res)
  return c < 0 || r < 0 || c >= T.cols || r >= T.rows ? -1 : r * T.cols + c
}
export const bounds = (T: Terrain): [number, number, number, number] => [T.w, T.n - T.rows * T.res, T.w + T.cols * T.res, T.n]

export type Extent = { mask: Uint8Array; prob: Uint8Array; km2: number; image: ImageData | null }
const KM2 = (0.0018 * 111.32) ** 2 * Math.cos((26.7 * Math.PI) / 180)

/** Predicted inundation for hour h: cells whose modelled flood probability passes p*. 0 = dry, 1 = predicted water, 2 = river. */
export function extentAt(M: ModelParams, T: Terrain, F: StationForecast[], h: number, style: 'predicted' | 'simulated' | 'none'): Extent {
  const tab = qEffTable(F, h), n = T.cols * T.rows
  const mask = new Uint8Array(n), prob = new Uint8Array(n)
  const lq = new Float32Array(200); for (let b = 0; b < 200; b++) lq[b] = tab[b]
  let cnt = 0
  for (let i = 0; i < n; i++) {
    const code = T.code[i]
    if (code === 255) continue
    if (code === 254) { mask[i] = 2; continue }
    const p = pixelP(M, lq[Math.min(199, T.ch[i])], Math.min(25, Math.max(-5, T.hand[i])), T.dk[i])
    prob[i] = Math.round(p * 255)
    if (p >= M.pixel.pstar) { mask[i] = 1; cnt++ }
  }
  let image: ImageData | null = null
  if (style !== 'none') {
    image = new ImageData(T.cols, T.rows); const d = image.data, C = T.cols
    // Hazard colours: pale yellow = watch (water possible), yellow = likely, orange = very likely, red = almost certain.
    const ps = M.pixel.pstar, watch = ps * 0.5 * 255
    for (let i = 0; i < n; i++) {
      if (mask[i] !== 1) {
        if (mask[i] === 0 && prob[i] > 0 && prob[i] >= watch && style !== 'simulated') { d[i * 4] = 255; d[i * 4 + 1] = 236; d[i * 4 + 2] = 90; d[i * 4 + 3] = 120 }
        continue
      }
      const r = (i / C) | 0, c = i - r * C
      const edge = (c > 0 && mask[i - 1] !== 1) || (c < C - 1 && mask[i + 1] !== 1) || (r > 0 && mask[i - C] !== 1) || (r < T.rows - 1 && mask[i + C] !== 1)
      const p = prob[i] / 255
      let a = 60 + Math.round(110 * Math.min(1, (p - M.pixel.pstar) / 0.4))
      if (style === 'simulated') a = (r + c) % 6 < 2 ? Math.min(255, a + 70) : Math.round(a * 0.45)
      if (edge) a = 230
      const over = p - ps
      const col = style === 'simulated' ? [34, 211, 238] : over >= 0.4 ? [220, 38, 38] : over >= 0.15 ? [249, 115, 22] : [250, 204, 21]
      d[i * 4] = col[0]; d[i * 4 + 1] = col[1]; d[i * 4 + 2] = col[2]; d[i * 4 + 3] = a
    }
  }
  return { mask, prob, km2: Math.round(cnt * KM2), image }
}
