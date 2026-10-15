import { useEffect, useMemo, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
import type { MapViewState } from '@deck.gl/core'
import { BitmapLayer, PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { TileLayer } from '@deck.gl/geo-layers'
import { FiCamera, FiMapPin, FiPause, FiPlay } from 'react-icons/fi'
import { AppBrand } from '../components/AppBrand'
import { FONT } from './shared'
import { buildSim, distanceToRiver, floodRing, fmtHours, hoursUntil, nearbyShelter, type LL } from './sim'
import { ArView } from './ArView'
import { englishRouteLine, hindiRouteLine, walkingRoute, type Walk } from './aws'
import { ListenButton, WalkSteps } from './AwsTools'

const NOIDA: LL = [28.5355, 77.391]
const latin = (s: string) => /^[\x20-\x7EÀ-ɏ]+$/.test(s)

/** Try the route and AR experience anywhere: a made-up flood is placed next to wherever you are. */
export default function SimRoute({ onHome }: { onHome: () => void }) {
  const [user, setUser] = useState<LL | null>(null)
  const [source, setSource] = useState<'gps' | 'default' | 'asking'>('asking')
  const [shelter, setShelter] = useState<{ n: string; lat: number; lng: number } | null>(null)
  const [hours, setHours] = useState(2)
  const [playing, setPlaying] = useState(false)
  const [ar, setAr] = useState(false)
  const raf = useRef(0)

  const locate = () => {
    setSource('asking')
    if (!navigator.geolocation) { setUser(NOIDA); setSource('default'); return }
    navigator.geolocation.getCurrentPosition(
      p => { setUser([p.coords.latitude, p.coords.longitude]); setSource('gps') },
      () => { setUser(NOIDA); setSource('default') }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 })
  }
  useEffect(() => { locate() }, [])
  useEffect(() => {
    if (!user) return
    setShelter(null)
    const c = new AbortController()
    nearbyShelter(user, c.signal).then(s => { if (!c.signal.aborted) setShelter(s) })
    return () => c.abort()
  }, [user])
  useEffect(() => {
    if (!playing) return
    let last = performance.now()
    const tick = (now: number) => {
      const dt = (now - last) / 1000; last = now
      setHours(h => { const n = h + dt * 0.8; return n >= 6 ? 0 : n })
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [playing])

  const sim = useMemo(() => (user ? buildSim(user, shelter) : null), [user, shelter])
  const [walk, setWalk] = useState<Walk | null>(null)
  const [walkErr, setWalkErr] = useState('')
  const [walkBusy, setWalkBusy] = useState(false)
  // real roads from Amazon Location Service replace the straight line, so the map and the AR chevrons follow actual streets
  useEffect(() => {
    if (!sim) return
    setWalk(null); setWalkErr(''); setWalkBusy(true)
    walkingRoute(sim.route.from, sim.route.to).then(setWalk).catch(e => setWalkErr((e as Error).message)).finally(() => setWalkBusy(false))
  }, [sim?.route.from[0], sim?.route.from[1], sim?.route.to[0], sim?.route.to[1]]) // eslint-disable-line react-hooks/exhaustive-deps
  const live = useMemo(() => (sim && walk && walk.path.length > 1 ? { ...sim.route, path: walk.path, km: walk.km } : sim?.route ?? null), [sim, walk])
  const view: MapViewState | null = useMemo(() => (user ? { latitude: user[0] - 0.002, longitude: user[1], zoom: 15.2, pitch: 58, bearing: 12 } : null), [user])

  if (!sim || !view || !user) {
    return <main className="route-page"><header className="route-top"><AppBrand onClick={onHome} /></header><section className="route-card"><h1>Finding your location…</h1><p>Allow location when your browser asks. If you decline, a demo location in Noida is used.</p></section></main>
  }
  const eta = hoursUntil(distanceToRiver(user, sim.river))
  const ring = floodRing(sim.river, user[0], sim.halfWidth(hours))
  const layers = [
    new TileLayer({ id: 'base', data: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', minZoom: 0, maxZoom: 19, tileSize: 256,
      renderSubLayers: (p: any) => { const b = p.tile.boundingBox; return new BitmapLayer(p, { data: undefined, image: p.data, bounds: [b[0][0], b[0][1], b[1][0], b[1][1]] }) } }),
    new PolygonLayer({ id: 'flood', data: [{ ring }], getPolygon: (d: any) => d.ring, extruded: true, getElevation: 4 + hours * 5, getFillColor: [40, 120, 220, 150], getLineColor: [180, 220, 255, 220], lineWidthMinPixels: 1, material: false, updateTriggers: { getElevation: hours } }),
    new PathLayer({ id: 'river', data: [{ path: sim.river.map(([la, ln]) => [ln, la]) }], getPath: (d: any) => d.path, getColor: [120, 190, 255, 255], getWidth: 4, widthUnits: 'pixels' }),
    new PathLayer({ id: 'glow', data: [{ path: (live ?? sim.route).path }], getPath: (d: any) => d.path, getColor: [6, 20, 16, 210], getWidth: 9, widthUnits: 'pixels', capRounded: true, jointRounded: true }),
    new PathLayer({ id: 'route', data: [{ path: (live ?? sim.route).path }], getPath: (d: any) => d.path, getColor: [52, 211, 153, 255], getWidth: 5, widthUnits: 'pixels', capRounded: true, jointRounded: true }),
    new ScatterplotLayer({ id: 'pts', data: [{ p: [user[1], user[0]], c: [217, 138, 24] }, { p: [sim.route.to[1], sim.route.to[0]], c: [52, 211, 153] }], getPosition: (d: any) => d.p, getRadius: 9, radiusUnits: 'pixels', getFillColor: (d: any) => d.c, stroked: true, getLineColor: [255, 255, 255], lineWidthMinPixels: 2 }),
    new TextLayer({ id: 'lbl', data: [{ p: [user[1], user[0]], t: 'You are here' }, { p: [sim.route.to[1], sim.route.to[0]], t: latin(sim.route.shelter) ? sim.route.shelter : 'Safe place' }],
      getPosition: (d: any) => d.p, getText: (d: any) => d.t, getSize: 14, getPixelOffset: [0, -22], getTextAnchor: 'middle', getColor: [13, 25, 18], background: true, getBackgroundColor: [252, 253, 250, 235], backgroundPadding: [6, 3], fontFamily: FONT, fontWeight: 650, characterSet: 'auto', fontSettings: { sdf: true } }),
  ]
  return (
    <main className="route-page">
      <header className="route-top"><AppBrand onClick={onHome} /><span className="pill sim">SIMULATION · not a real flood</span></header>
      <section className="route-head">
        <p className="eyebrow">Try it anywhere</p>
        <h1>A flood, placed next to you</h1>
        <p className="route-sub">A made-up river runs {sim.riverGapM} m north of {source === 'gps' ? 'your location' : 'a demo location in Noida'}. Its flood spreads with time. Water reaches you in <b>{fmtHours(eta)}</b>. Walk to <b>{sim.route.shelter}</b>, {(sim.route.km * 1000).toFixed(0)} m away{sim.shelterReal ? ' (a real mapped place)' : ''}.</p>
      </section>
      <div className="route-map">
        <DeckGL initialViewState={view} controller layers={layers} getCursor={() => 'grab'} />
        <div className="sim-time">
          <button onClick={() => setPlaying(p => !p)} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <FiPause /> : <FiPlay />}</button>
          <input type="range" min={0} max={6} step={0.05} value={hours} onChange={e => { setPlaying(false); setHours(Number(e.target.value)) }} aria-label="Hours from now" />
          <span>{hours < 0.05 ? 'Now' : `+${hours.toFixed(1)} h`}</span>
        </div>
        <div className="map-attr" style={{ bottom: 6 }}>Imagery © Esri, Maxar · simulation</div>
      </div>
      <div className="route-actions">
        <button className="route-btn primary" onClick={() => setAr(true)}><FiCamera /> Open AR view</button>
        <button className="route-btn" onClick={locate}><FiMapPin /> {source === 'gps' ? 'Use my location again' : 'Use my real location'}</button>
        <ListenButton text={hindiRouteLine({ ...sim.route, v: 'यहाँ', ex: true })} />
        <ListenButton text={englishRouteLine({ ...sim.route, v: 'this area', ex: true })} lang="en" />
      </div>
      <WalkSteps walk={walk} loading={walkBusy} error={walkErr} />
      <p className="route-note">Drag the slider to watch the flood spread. Tilt and rotate the map with two fingers. This is a rehearsal: the river and the water are invented so the route and AR views can be tried where there is no river. Real routes come from the live map.</p>
      {ar && <ArView route={live ?? sim.route} onClose={() => setAr(false)} flood={{ river: sim.river, hours, halfWidth: sim.halfWidth }} />}
    </main>
  )
}
