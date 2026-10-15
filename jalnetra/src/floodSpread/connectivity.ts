/**
 * Utilities for making the browser flood extent honest about connectivity.
 *
 * The existing extent model scores each terrain cell from discharge, height
 * above channel and distance-to-channel. That score is useful for a visual
 * estimate, but a disconnected island of scored cells should not be shown as
 * a continuous spread. These helpers retain only scored cells that can be
 * reached from an encoded river cell through neighboring scored cells.
 *
 * There is deliberately no distance/radius rule here. Connectivity comes
 * from the supplied raster topology and the model's supplied cell mask.
 */

export type SpreadSummary = {
  riverCells: number
  connectedCells: number
  connectedKm2: number
  frontierCells: number
  maxHandM: number | null
}

export type ConnectivityResult = {
  mask: Uint8Array
  summary: SpreadSummary
}

type ConnectivityInput = {
  mask: Uint8Array
  prob: Uint8Array
  cols: number
  rows: number
  /** Height above channel in metres, when available for a summary. */
  hand?: Float32Array
  /** Pixel resolution in degrees. */
  res?: number
  /** Latitude used to convert a raster cell to an approximate area. */
  latitude?: number
}

const neighbours = (cell: number, cols: number, rows: number, visit: (next: number) => void) => {
  const row = Math.floor(cell / cols)
  const col = cell - row * cols
  if (col > 0) visit(cell - 1)
  if (col + 1 < cols) visit(cell + 1)
  if (row > 0) visit(cell - cols)
  if (row + 1 < rows) visit(cell + cols)
}

const cellAreaKm2 = (res: number, latitude: number) => {
  const latKm = res * 111.32
  const lngKm = latKm * Math.cos((latitude * Math.PI) / 180)
  return latKm * lngKm
}

/**
 * Keep river cells and predicted cells connected to the river network.
 *
 * `mask` follows the existing engine convention: 0 dry, 1 predicted, 2
 * river. `prob` is retained for the caller's visualization and is used only
 * to calculate a probability-weighted frontier summary.
 */
export function connectedSpread(input: ConnectivityInput): ConnectivityResult {
  const { mask, prob, cols, rows } = input
  const size = cols * rows
  if (cols <= 0 || rows <= 0 || mask.length !== size || prob.length !== size) {
    throw new Error('Flood spread raster dimensions do not match the supplied cells.')
  }

  const connected = new Uint8Array(size)
  const queue: number[] = []
  let riverCells = 0
  for (let i = 0; i < size; i++) {
    if (mask[i] === 2) {
      connected[i] = 2
      queue.push(i)
      riverCells++
    }
  }

  // A simple array queue avoids allocating one object per terrain cell.
  for (let head = 0; head < queue.length; head++) {
    const cell = queue[head]
    neighbours(cell, cols, rows, next => {
      if (connected[next] !== 0 || mask[next] !== 1) return
      connected[next] = 1
      queue.push(next)
    })
  }

  const res = input.res ?? 0.0018
  const latitude = input.latitude ?? 26.7
  const area = cellAreaKm2(res, latitude)
  let connectedCells = 0
  let frontierCells = 0
  let maxHandM: number | null = null

  for (let i = 0; i < size; i++) {
    if (connected[i] !== 1) continue
    connectedCells++
    if (input.hand) maxHandM = maxHandM === null ? input.hand[i] : Math.max(maxHandM, input.hand[i])
    let frontier = false
    neighbours(i, cols, rows, next => {
      if (connected[next] === 0) frontier = true
    })
    if (frontier && prob[i] > 0) frontierCells++
  }

  return {
    mask: connected,
    summary: {
      riverCells,
      connectedCells,
      connectedKm2: Math.round(connectedCells * area * 10) / 10,
      frontierCells,
      maxHandM: maxHandM === null ? null : Math.round(maxHandM * 10) / 10,
    },
  }
}
