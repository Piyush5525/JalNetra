import { useEffect, useMemo, useRef, useState } from 'react'
import { HORIZONS } from '../engine/core'
import { loadTerrain, type Terrain } from '../engine/terrain'
import { M } from '../live/shared'
import { makeSpreadResult, spreadImage, type Horizon } from './model'
import './floodSpread.css'

const drawSpread = (canvas: HTMLCanvasElement, result: ReturnType<typeof makeSpreadResult>) => {
  canvas.width = result.terrain.cols
  canvas.height = result.terrain.rows
  const ctx = canvas.getContext('2d', { alpha: true })
  if (ctx) ctx.putImageData(spreadImage(result), 0, 0)
}

export default function FloodSpreadPanel({ onHorizonChange }: { onHorizonChange?: (horizon: Horizon) => void }) {
  const [terrain, setTerrain] = useState<Terrain | null>(null)
  const [horizon, setHorizon] = useState<Horizon>(24)
  const [error, setError] = useState<string | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let alive = true
    loadTerrain(M).then(value => { if (alive) setTerrain(value) }).catch(() => { if (alive) setError('Terrain grid could not be loaded.') })
    return () => { alive = false }
  }, [])

  const result = useMemo(() => {
    if (!terrain) return null
    try { return makeSpreadResult(terrain, horizon) } catch { return null }
  }, [terrain, horizon])

  useEffect(() => {
    if (result && canvasRef.current) drawSpread(canvasRef.current, result)
  }, [result])

  return (
    <section className="flood-spread" aria-labelledby="flood-spread-title">
      <div className="flood-spread-head">
        <div>
          <div className="kicker">Read-only map aid</div>
          <div className="h" id="flood-spread-title">Flood spread estimate</div>
        </div>
        <span className="flood-spread-badge">PRELIMINARY</span>
      </div>
      <p className="flood-spread-warning">Terrain-connected estimate from the bundled September 2026 replay. It is not a validated hydraulic forecast and must not trigger an alert by itself.</p>
      <div className="flood-spread-horizons" role="group" aria-label="Flood spread estimate horizon">
        {HORIZONS.map(value => <button key={value} className={value === horizon ? 'on' : ''} onClick={() => { setHorizon(value); onHorizonChange?.(value) }}>{value === 0 ? 'Now' : `+${value}h`}</button>)}
      </div>
      <div className="flood-spread-map">
        {result ? <canvas ref={canvasRef} aria-label={`Preliminary terrain-connected flood spread at ${horizon === 0 ? 'now' : `plus ${horizon} hours`}`} /> : <div className="flood-spread-loading">{error ?? (terrain ? 'The bundled replay could not be evaluated.' : 'Loading terrain…')}</div>}
      </div>
      {(error || (terrain && !result)) && <p className="note">{error ?? 'The bundled replay could not be evaluated.'} No spread is inferred.</p>}
      {result && <>
        <dl className="kv small flood-spread-facts">
          <dt>Connected water</dt><dd>{result.summary.connectedKm2.toLocaleString()} km² estimate</dd>
          <dt>Terrain cells</dt><dd>{result.summary.connectedCells.toLocaleString()} linked to the river</dd>
          <dt>Potential front</dt><dd>{result.summary.frontierCells.toLocaleString()} edge cells</dd>
          <dt>Max HAND</dt><dd>{result.summary.maxHandM === null ? '—' : `${result.summary.maxHandM} m above channel`}</dd>
        </dl>
         <div className="flood-spread-legend"><span><i className="observed" />Observed Sentinel-1 pass</span><span><i className="river" />River cells</span><span><i className="water" />Connected estimate</span></div>
         <p className="note">The main map also shows the bundled observed Sentinel-1 pass in green; the blue layer is the preliminary model estimate. Inputs: {result.run.inputs.observations} replay observations, GloFAS discharge at {result.run.stations.length} stations and the bundled Copernicus-derived terrain grid. Cells are shown only when the model mask connects to an encoded river cell; no fixed-radius river buffer is used.</p>
      </>}
      <p className="flood-spread-source">Visualization only · existing model/terrain assets · no incident or alert side effects</p>
    </section>
  )
}
