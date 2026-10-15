import { useEffect, useMemo, useState } from 'react'
import DeckGL from '@deck.gl/react'
import { type MapViewState } from '@deck.gl/core'
import { BitmapLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { TileLayer } from '@deck.gl/geo-layers'
import { FiCamera, FiCopy, FiExternalLink, FiNavigation } from 'react-icons/fi'
import { AppBrand } from '../components/AppBrand'
import { decodeRoute, mapsLink, simplify, type SharedRoute } from './routeShare'
import { ArView } from './ArView'
import { FONT } from './shared'
import { englishRouteLine, hindiRouteLine, type Walk } from './aws'
import { ListenButton, WalkSteps } from './AwsTools'
import MapboxRoute, { MAPBOX_TOKEN, computeRealRoute, resolveSafePlace, type Place } from './MapboxRoute'

const latin = (s: string) => /^[\x20-\x7EÀ-ɏ]+$/.test(s)

/** The page a village head opens from the Telegram message: the predicted evacuation route on a 3D map, plus an AR view on a phone. */
export default function RoutePage({ onHome }: { onHome: () => void }) {
  const route = useMemo(() => decodeRoute(new URLSearchParams(location.search).get('d')), [])
  const [ar, setAr] = useState(() => new URLSearchParams(location.search).get('ar') === '1')
  const [copied, setCopied] = useState(false)
  const [walk, setWalk] = useState<Walk | null>(null)
  const [walkErr, setWalkErr] = useState('')
  const [walkBusy, setWalkBusy] = useState(false)
  const [mapMode, setMapMode] = useState<'current' | '2d' | '3d'>(() => { const m = new URLSearchParams(location.search).get('map'); return m === '2d' || m === '3d' ? m : 'current' })
  const [place, setPlace] = useState<Place | null>(null)
  const [routeNote, setRouteNote] = useState('')
  const [drive, setDrive] = useState<Walk | null>(null)
  const [stepsTab, setStepsTab] = useState<'drive' | 'walk'>('drive')
  useEffect(() => {
    if (!route) return
    const ac = new AbortController()
    setWalkBusy(true); setWalkErr('')
    // 1. find the safe place's exact point (Google Maps via SerpAPI), 2. walk there with Mapbox Directions (OSM foot routing if unavailable)
    ;(async () => {
      const found = await resolveSafePlace(route, ac.signal)
      setPlace(found)
      const r = await computeRealRoute(route, found, ac.signal)
      if (ac.signal.aborted) return
      setWalk(r.walk); setDrive(r.drive); setRouteNote(r.note)
      if (!r.walk && !r.drive) setWalkErr(r.note || 'No road route could be found.')
    })().finally(() => { if (!ac.signal.aborted) setWalkBusy(false) })
    return () => ac.abort()
  }, [route])
  // AR and Google Maps use the exact place and the walking path when they are known
  const target: SharedRoute | null = useMemo(() => !route ? null : !place && !walk ? route : {
    ...route,
    ...(place ? { to: [place.lat, place.lng] as [number, number], shelter: place.name } : {}),
    ...(walk ? { km: walk.km, path: simplify(walk.path as [number, number][], 60) } : {}),
  }, [route, place, walk])
  const view: MapViewState = useMemo(() => {
    const lats = route ? [route.from[0], route.to[0]] : [26.8], lngs = route ? [route.from[1], route.to[1]] : [84.5]
    const lat = (Math.min(...lats) + Math.max(...lats)) / 2, lng = (Math.min(...lngs) + Math.max(...lngs)) / 2
    const span = Math.max(Math.max(...lats) - Math.min(...lats), Math.max(...lngs) - Math.min(...lngs), 0.004)
    return { latitude: lat, longitude: lng, zoom: Math.max(9, Math.min(15.5, Math.log2(0.9 / span) + 7.3)), pitch: 55, bearing: -15 }
  }, [route])

  if (!route) {
    return (
      <main className="route-page">
        <header className="route-top"><AppBrand onClick={onHome} /></header>
        <section className="route-card"><h1>This route link is not valid</h1><p>Ask the operator to send the evacuation route again from the JalNetra live map.</p></section>
      </main>
    )
  }
  // draw the walkable route when it is known; the model's own path is only a terrain estimate and can cut across rough ground
  const T = target ?? route
  const layers = [
    new TileLayer({ id: 'base', data: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', minZoom: 0, maxZoom: 17, tileSize: 256,
      renderSubLayers: (p: any) => { const b = p.tile.boundingBox; return new BitmapLayer(p, { data: undefined, image: p.data, bounds: [b[0][0], b[0][1], b[1][0], b[1][1]] }) } }),
    // real routes only: on foot (blue) under by car (green)
    ...(walk ? [new PathLayer({ id: 'walk-glow', data: [{ path: walk.path }], getPath: (d: any) => d.path, getColor: [255, 255, 255, 220], getWidth: 8, widthUnits: 'pixels', capRounded: true, jointRounded: true }),
      new PathLayer({ id: 'walk', data: [{ path: walk.path }], getPath: (d: any) => d.path, getColor: [23, 105, 224, 255], getWidth: 4.5, widthUnits: 'pixels', capRounded: true, jointRounded: true })] : []),
    ...(drive ? [new PathLayer({ id: 'drive-glow', data: [{ path: drive.path }], getPath: (d: any) => d.path, getColor: [255, 255, 255, 230], getWidth: 11, widthUnits: 'pixels', capRounded: true, jointRounded: true }),
      new PathLayer({ id: 'drive', data: [{ path: drive.path }], getPath: (d: any) => d.path, getColor: [18, 128, 92, 255], getWidth: 6, widthUnits: 'pixels', capRounded: true, jointRounded: true })] : []),
    new ScatterplotLayer({ id: 'pts', data: [{ p: [route.from[1], route.from[0]], c: [217, 138, 24], t: route.v }, { p: [T.to[1], T.to[0]], c: [52, 211, 153], t: T.shelter }], getPosition: (d: any) => d.p, getRadius: 9, radiusUnits: 'pixels', getFillColor: (d: any) => d.c, stroked: true, getLineColor: [255, 255, 255], lineWidthMinPixels: 2 }),
    new TextLayer({ id: 'lbl', data: [{ p: [route.from[1], route.from[0]], t: route.v }, { p: [T.to[1], T.to[0]], t: latin(T.shelter) ? T.shelter : 'Safe place' }], getPosition: (d: any) => d.p, getText: (d: any) => d.t, getSize: 14, getPixelOffset: [0, -22], getTextAnchor: 'middle', getColor: [13, 25, 18], background: true, getBackgroundColor: [252, 253, 250, 235], backgroundPadding: [6, 3], fontFamily: FONT, fontWeight: 650, characterSet: 'auto', fontSettings: { sdf: true } }),
  ]
  const copy = async () => { try { await navigator.clipboard.writeText(location.href); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* clipboard unavailable */ } }
  return (
    <main className="route-page">
      <header className="route-top"><AppBrand onClick={onHome} />{route.ex && <span className="pill sim">EXERCISE · not a real alert</span>}</header>
      <section className="route-head">
        <p className="eyebrow">Evacuation route</p>
        <h1>{route.v}{route.d ? `, ${route.d}` : ''}</h1>
        <div className="route-chips">
          <span className={'rchip risk lv-' + route.lvl}>{route.lvl} risk</span>
          {route.when && <span className="rchip">Water {route.when}</span>}
          <span className="rchip safe">To {place?.name || route.shelter}</span>
        </div>
      </section>

      <div className="route-map">
        {mapMode === 'current'
          ? <><DeckGL initialViewState={view} controller layers={layers} getCursor={() => 'grab'} /><div className="map-attr" style={{ bottom: 6 }}>Imagery © Esri, Maxar</div></>
          : <MapboxRoute route={route} walk={walk} drive={drive} place={place} mode={mapMode} />}
        <div className="map-seg" role="group" aria-label="Map view">
          {([['current', 'Satellite'], ['2d', '2D'], ['3d', '3D']] as const).filter(([k]) => k === 'current' || MAPBOX_TOKEN).map(([k, l]) => (
            <button key={k} onClick={() => setMapMode(k)} aria-pressed={mapMode === k} className={mapMode === k ? 'on' : ''}>{l}</button>
          ))}
        </div>
        {mapMode === 'current' && (walk || drive) && (
          <div className="map-legend">
            {drive && <span><i className="sw car" /> By car <b>{drive.km.toFixed(1)} km · {drive.minutes} min</b></span>}
            {walk && <span><i className="sw foot" /> On foot <b>{walk.km.toFixed(1)} km · {walk.minutes} min</b></span>}
          </div>
        )}
        {walkBusy && <div className="map-busy"><span className="spin-dot" /> Finding the best road route…</div>}
      </div>

      <div className="route-grid">
        <section className="route-card2">
          <div className="rc-kicker">Safe place</div>
          <h2>{place?.name || route.shelter}</h2>
          <p className="rc-sub">
            {place?.address || `About ${route.km.toFixed(1)} km from ${route.v}`}
            {place?.phone ? <> · <a href={`tel:${place.phone.replace(/\s+/g, '')}`}>{place.phone}</a></> : null}
          </p>
          {place && <p className="rc-src">{place.source === 'google-maps' ? 'Exact location from Google Maps' : 'Predicted location'} · {place.lat.toFixed(4)}, {place.lng.toFixed(4)}</p>}
          <div className="rc-actions">
            <button className="btn-primary" onClick={() => setAr(true)}><FiCamera /> Open AR view</button>
            <a className="btn-soft" href={mapsLink(target ?? route)} target="_blank" rel="noreferrer"><FiNavigation /> Google Maps <FiExternalLink /></a>
          </div>
          <div className="rc-row">
            <span className="rc-label">Listen</span>
            <div className="seg-group">
              <ListenButton text={hindiRouteLine(route)} short className="seg-btn" />
              <ListenButton text={englishRouteLine(route)} lang="en" short className="seg-btn" />
            </div>
            <button className="btn-ghost" onClick={() => void copy()}><FiCopy /> {copied ? 'Copied' : 'Copy link'}</button>
          </div>
        </section>

        <section className="route-card2">
          <div className="rc-kicker">Directions</div>
          <div className="seg-group tabs" role="tablist">
            <button role="tab" aria-selected={stepsTab === 'drive'} className={'seg-btn' + (stepsTab === 'drive' ? ' on' : '')} onClick={() => setStepsTab('drive')} disabled={!drive}>By car{drive ? ` · ${drive.km.toFixed(1)} km` : ''}</button>
            <button role="tab" aria-selected={stepsTab === 'walk'} className={'seg-btn' + (stepsTab === 'walk' ? ' on' : '')} onClick={() => setStepsTab('walk')} disabled={!walk}>On foot{walk ? ` · ${walk.km.toFixed(1)} km` : ''}</button>
          </div>
          {routeNote && <p className="rc-note">{routeNote}</p>}
          <WalkSteps walk={stepsTab === 'drive' ? (drive ?? walk) : (walk ?? drive)} loading={walkBusy} error={walkErr} label={stepsTab === 'drive' ? 'Driving' : 'Walking'} />
        </section>
      </div>

      <p className="route-note">{route.ex ? 'This is a rehearsal. ' : ''}The destination is chosen from river, rain and terrain data, issued {new Date(route.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}. The lines follow mapped roads and are not checked against the flood map. Follow instructions from local authorities. Not an official evacuation order.</p>
      {ar && <ArView route={target ?? route} onClose={() => setAr(false)} />}
    </main>
  )
}
