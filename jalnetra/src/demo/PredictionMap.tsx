import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
import { GeoJsonLayer, BitmapLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { PathStyleExtension } from '@deck.gl/extensions'
import type { MapViewState } from '@deck.gl/core'
import { countryBorders as countries } from '../countryBorders'
import D from '../data.json'
import { HORIZONS } from '../engine/core'
import { bounds, extentAt, loadTerrain, type Terrain } from '../engine/terrain'
import { buildGraph, evacuate, type Route } from '../engine/route'
import { M } from '../live/shared'
import type { DemoPredictionReference, Horizon } from './types'
import { computePrediction, unionRouteWater, validatePredictionReference } from './prediction'
import './prediction-map.css'

const ROUTE_EXTENSIONS = [new PathStyleExtension({ dash: true })]
const HARPur_VIEW: MapViewState = { longitude: 84.399, latitude: 26.6099, zoom: 10.2, pitch: 0, bearing: 0 }
const asCanvas = (image: ImageData | null) => {
  if (!image) return null
  const canvas = document.createElement('canvas')
  canvas.width = image.width; canvas.height = image.height
  canvas.getContext('2d')?.putImageData(image, 0, 0)
  return canvas
}

type Output = ReturnType<typeof computePrediction> & {
  terrain: Terrain
  extents: Record<number, ReturnType<typeof extentAt> & { canvas: HTMLCanvasElement | null }>
  route: Route | null
}

export default function PredictionMap({ prediction, horizon, onHorizonChange, readOnly = false, onReady }: {
  prediction: DemoPredictionReference
  horizon: Horizon
  onHorizonChange?: (h: Horizon) => void
  readOnly?: boolean
  onReady?: (ready: boolean) => void
}) {
  const [output, setOutput] = useState<Output | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [mapPainted, setMapPainted] = useState(false)
  const [view, setView] = useState<MapViewState>(() => ({ ...HARPur_VIEW, longitude: prediction.lng, latitude: prediction.lat }))
  const onReadyRef = useRef(onReady)
  const readyRef = useRef<boolean | null>(null)
  const outputRef = useRef<Output | null>(null)
  onReadyRef.current = onReady
  outputRef.current = output

  const notifyReady = useCallback((ready: boolean) => {
    if (readyRef.current === ready) return
    readyRef.current = ready
    onReadyRef.current?.(ready)
  }, [])

  useEffect(() => {
    let active = true
    notifyReady(false); setLoading(true); setError(null); setOutput(null); setMapPainted(false)
    try {
      // Fail closed before loading terrain or creating any map layers.
      const checked = validatePredictionReference(prediction, M)
      if (!checked.ok) throw new Error(checked.error)
      const computed = computePrediction(prediction, M)
      loadTerrain(M).then(terrain => {
        if (!active) return
        const extents: Output['extents'] = {}
        for (const h of HORIZONS) {
          const extent = extentAt(M, terrain, computed.run.stations, h, 'simulated')
          extents[h] = { ...extent, canvas: asCanvas(extent.image) }
        }
        const water = unionRouteWater(extents[0], extents[24])
        const graph = buildGraph((D as any).roads ?? [], terrain)
        const route = evacuate(graph, terrain, water.mask, water.prob, M.pixel.pstar, computed.village, M.pois)
        if (!active) return
        setOutput({ ...computed, terrain, extents, route }); setLoading(false)
      }).catch((reason: unknown) => {
        if (!active) return
        setLoading(false); setError(`Prediction map asset failed: ${reason instanceof Error ? reason.message : String(reason)}`); notifyReady(false)
      })
    } catch (reason: unknown) {
      setLoading(false); setError(reason instanceof Error ? reason.message : String(reason)); notifyReady(false)
    }
    return () => { active = false }
  }, [prediction, notifyReady])

  useEffect(() => {
    const village = output?.village ?? { lng: prediction.lng, lat: prediction.lat }
    setView(v => ({ ...v, longitude: village.lng, latitude: village.lat, zoom: 10.2 }))
  }, [prediction.scenarioId, prediction.villageId, prediction.lng, prediction.lat, output?.village])

  const onAfterRender = useCallback(() => {
    if (outputRef.current) { setMapPainted(true); notifyReady(true) }
  }, [notifyReady])
  const onMapError = useCallback((reason: Error) => {
    setError(`Map/WebGL failed: ${reason.message}`); notifyReady(false)
  }, [notifyReady])

  const selectedExtent = output?.extents[horizon]
  const layers = useMemo(() => {
    if (!output || !selectedExtent) return []
    const tb = bounds(output.terrain)
    const route = output.route
    const selected = output.village
    const out: any[] = [
      new GeoJsonLayer({ id: 'countries', data: countries as any, filled: false, stroked: true, getLineColor: [255, 255, 255, 100], lineWidthMinPixels: 1 }),
      new PathLayer({ id: 'river-network', data: (D as any).network ?? [], getPath: (d: any) => d as any, getColor: [125, 211, 252, 130], widthMinPixels: 1 }),
      new BitmapLayer({ id: `predicted-inundation-${horizon}`, image: selectedExtent.canvas, bounds: tb, opacity: 1, textureParameters: { minFilter: 'nearest', magFilter: 'nearest' } as any }),
      new ScatterplotLayer({ id: 'selected-village', data: [selected], getPosition: (d: any) => [d.lng, d.lat], getRadius: 9, radiusUnits: 'pixels', getFillColor: [251, 191, 36, 255], stroked: true, getLineColor: [255, 255, 255, 255], lineWidthMinPixels: 2 }),
      new TextLayer({ id: 'selected-village-label', data: [selected], getPosition: (d: any) => [d.lng, d.lat], getText: (d: any) => d.name, getSize: 13, getPixelOffset: [12, -2], getTextAnchor: 'start', getColor: [255, 255, 255, 255], outlineWidth: 3, outlineColor: [0, 0, 0, 230], fontSettings: { sdf: true } }),
    ]
    if (route) {
      out.push(
        new PathLayer({ id: 'suggested-route-glow', data: [route], getPath: (d: Route) => d.path, getColor: [8, 15, 24, 220], getWidth: 8, widthUnits: 'pixels', capRounded: true, jointRounded: true }),
        new PathLayer({ id: 'suggested-route', data: [route], getPath: (d: Route) => d.path, getColor: route.ok ? [52, 211, 153, 255] : [251, 191, 36, 255], getWidth: 3.5, widthUnits: 'pixels', capRounded: true, jointRounded: true, getDashArray: () => [6, 4], extensions: ROUTE_EXTENSIONS }),
        new ScatterplotLayer({ id: 'suggested-shelter', data: [route.shelter], getPosition: (d: any) => [d.x, d.y], getRadius: 8, radiusUnits: 'pixels', getFillColor: [52, 211, 153, 255], stroked: true, getLineColor: [255, 255, 255, 255], lineWidthMinPixels: 2 }),
        new TextLayer({ id: 'suggested-shelter-label', data: [route.shelter], getPosition: (d: any) => [d.x, d.y], getText: (d: any) => d.n, getSize: 12, getPixelOffset: [11, 0], getTextAnchor: 'start', getColor: [209, 250, 229, 255], outlineWidth: 3, outlineColor: [0, 0, 0, 230], fontSettings: { sdf: true } }),
      )
    }
    return out
  }, [output, selectedExtent, horizon])

  const risk = output?.risk
  const change = (index: number) => onHorizonChange?.(HORIZONS[Math.max(0, Math.min(HORIZONS.length - 1, index))] as Horizon)
  const currentIndex = HORIZONS.indexOf(horizon)
  const status = loading ? 'Loading the bundled terrain and historical replay…' : error
  const ready = Boolean(output && mapPainted && !error)

  return <section className="demo-prediction" aria-label="Historical replay prediction map">
    <header className="prediction-heading">
      <div><div className="prediction-exercise">EXERCISE / अभ्यास · NOT A REAL FLOOD WARNING</div><h3>{prediction.villageName} flood prediction</h3><p className="prediction-source">Bundled historical replay · model {M.version} · simulated {new Date(prediction.simulatedClock).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST</p></div>
      <p className="prediction-source">Forecast uncertainty: {risk?.conf ?? '—'} confidence</p>
    </header>
    <div className="prediction-controls">
      <div className="prediction-horizons" aria-label="Prediction horizon">
        <button type="button" aria-label="Previous horizon" onClick={() => change(currentIndex - 1)} disabled={readOnly || currentIndex <= 0}>−</button>
        {HORIZONS.map(h => <button type="button" key={h} aria-pressed={h === horizon} onClick={() => onHorizonChange?.(h as Horizon)} disabled={readOnly}>{h === 0 ? 'NOW' : `+${h}H`}</button>)}
        <button type="button" aria-label="Next horizon" onClick={() => change(currentIndex + 1)} disabled={readOnly || currentIndex >= HORIZONS.length - 1}>+</button>
      </div>
      <p className="prediction-source">Water extent shown for {horizon === 0 ? 'now' : `+${horizon} hours`}; route uses NOW ∪ +24H</p>
    </div>
    <div className="prediction-map-frame">
      {output && !error && <DeckGL viewState={view} onViewStateChange={(event: any) => setView(event.viewState)} controller layers={layers} onAfterRender={onAfterRender} onError={onMapError} getCursor={({ isHovering }) => isHovering ? 'pointer' : 'grab'} />}
      <div className="prediction-legend" aria-label="Map legend"><span><i className="prediction-swatch flood" />Predicted inundation extent</span><span><i className="prediction-swatch route" />Suggested evacuation route</span><span><i className="prediction-swatch river" />River / network</span></div>
      {status && <div className="prediction-map-status"><strong>{status}</strong><p>{error ? 'No prediction is shown because the replay identity, terrain asset, or map renderer could not be verified.' : 'Preparing the selected village prediction.'}</p></div>}
    </div>
    {output && risk && !error && <>
      <dl className="prediction-facts"><div><dt>Flood probability at horizon</dt><dd>{Math.round(risk.pAt[horizon] * 100)}%</dd></div><div><dt>Impact window</dt><dd>{risk.window ? `${risk.window[0]}–${risk.window[1]} h` : 'Not within 48 h'}</dd></div><div><dt>Map readiness</dt><dd>{ready ? 'Rendered' : 'Rendering…'}</dd></div></dl>
      <div className="prediction-details"><p className="prediction-source">Model uncertainty is shown as {risk.conf.toLowerCase()} confidence from its forecast spread; it is not a calibrated probability guarantee.</p>
        {output.route ? <div className="prediction-route-note"><p><strong>Suggested destination:</strong> {output.route.shelter.n} · {output.route.km.toFixed(1)} km</p><p><strong>Wet route:</strong> {output.route.wetKm.toFixed(1)} km. {output.route.why}</p><p className="prediction-source">This is a model suggestion, not a confirmed relief camp or guaranteed safe route.</p></div> : <div className="prediction-route-note"><p><strong>No route found.</strong> No mapped path to a dry school or hospital was available under the NOW ∪ +24H water mask.</p></div>}
      </div>
    </>}
  </section>
}
