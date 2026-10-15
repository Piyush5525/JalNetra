import { useEffect, useRef, useState } from 'react'
import mapboxgl from 'mapbox-gl'
import 'mapbox-gl/dist/mapbox-gl.css'
import type { SharedRoute } from './routeShare'
import { walkingRoute, type Walk } from './aws'

export const MAPBOX_TOKEN = (import.meta.env.VITE_MAPBOX_TOKEN as string | undefined) || ''

/** The safe place as found on Google Maps (SerpAPI): exact point and address. */
export type Place = { name: string; address?: string; lat: number; lng: number; phone?: string; source: 'google-maps' | 'predicted' }

/** Find the safe place's exact location through the local SerpAPI helper. Falls back to the predicted point. */
export async function resolveSafePlace(route: SharedRoute, signal?: AbortSignal): Promise<Place> {
  const predicted: Place = { name: route.shelter, lat: route.to[0], lng: route.to[1], source: 'predicted' }
  try {
    const q = new URLSearchParams({ name: route.shelter, lat: String(route.to[0]), lng: String(route.to[1]) })
    const res = await fetch(`/local-api/place?${q}`, { signal })
    if (!res.ok) return predicted
    const b = await res.json() as { place?: Omit<Place, 'source'> | null }
    return b.place ? { ...b.place, source: 'google-maps' } : predicted
  } catch { return predicted }
}

export type GoogleFigures = { km: number; minutes: number; steps: Walk['steps'] }

/** Google Maps' own distance, time and turns (through SerpAPI). It carries no geometry. */
export async function googleWalk(from: [number, number], to: [number, number], signal?: AbortSignal, mode: 'walking' | 'driving' = 'walking'): Promise<GoogleFigures | null> {
  try {
    const q = new URLSearchParams({ flat: String(from[0]), flng: String(from[1]), tlat: String(to[0]), tlng: String(to[1]), mode })
    const res = await fetch(`/local-api/directions?${q}`, { signal })
    if (!res.ok) return null
    const b = await res.json() as { directions?: GoogleFigures | null }
    return b.directions ?? null
  } catch { return null }
}

/** A route over real mapped roads and paths from Mapbox Directions, for walking or driving. */
export async function mapboxRoute(from: [number, number], to: [number, number], profile: 'walking' | 'driving', signal?: AbortSignal): Promise<Walk> {
  if (!MAPBOX_TOKEN) throw new Error('Mapbox token is not configured')
  const url = `https://api.mapbox.com/directions/v5/mapbox/${profile}/${from[1]},${from[0]};${to[1]},${to[0]}?geometries=geojson&steps=true&overview=full&access_token=${MAPBOX_TOKEN}`
  const res = await fetch(url, { signal })
  const d = await res.json()
  const r = d.routes?.[0]
  if (!res.ok || !r) throw new Error(d.message || `No ${profile} route found`)
  const dist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`)
  const steps = (r.legs as any[]).flatMap(l => l.steps).filter((st: any) => st.distance > 0)
    .map((st: any) => ({ meters: Math.round(st.distance), minutes: Math.max(1, Math.round(st.duration / 60)), direction: st.maneuver?.modifier ?? 'straight', text: `${st.maneuver?.instruction ?? 'Continue'} (${dist(st.distance)})` }))
  return { km: Number((r.distance / 1000).toFixed(2)), minutes: Math.round(r.duration / 60), path: r.geometry.coordinates, steps, source: profile === 'driving' ? 'Mapbox Directions (driving)' : 'Mapbox Directions (walking)' }
}

export type RealRoutes = { walk: Walk | null; drive: Walk | null; googleDrive: GoogleFigures | null; googleWalk: GoogleFigures | null; note: string }

/**
 * Real routes only: a walking route and a driving route along mapped roads and paths. The model's own ground estimate is not
 * drawn, because it can cut across fields and rivers where nobody can go. Google's figures are fetched for comparison: where a
 * local track is missing from the road data, the mapped route is longer than what Google shows.
 */
export async function computeRealRoute(route: SharedRoute, place: Place, signal?: AbortSignal): Promise<RealRoutes> {
  const to: [number, number] = [place.lat, place.lng]
  const [walk, drive, gw, gd] = await Promise.all([
    (async () => { try { return MAPBOX_TOKEN ? await mapboxRoute(route.from, to, 'walking', signal) : await walkingRoute(route.from, to) } catch { try { return await walkingRoute(route.from, to) } catch { return null } } })(),
    (async () => { try { return await mapboxRoute(route.from, to, 'driving', signal) } catch { return null } })(),
    googleWalk(route.from, to, signal, 'walking'),
    googleWalk(route.from, to, signal, 'driving'),
  ])
  const parts: string[] = []
  if (gd && drive && drive.km > gd.km * 1.5) parts.push(`Google Maps shows ${gd.km.toFixed(1)} km (${gd.minutes} min by car) over a local track that is missing from the road map used here, so the car line follows mapped roads (${drive.km.toFixed(1)} km).`)
  if (!drive && !walk) parts.push(gd ? `No mapped road route found. Google Maps shows ${gd.km.toFixed(1)} km, ${gd.minutes} min by car.` : 'No road route could be found.')
  else if (!drive) parts.push('No driving route exists on the mapped roads.')
  return { walk, drive, googleDrive: gd, googleWalk: gw, note: parts.join(' ') }
}

const line = (coords: [number, number][]) => ({ type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: coords } })

/** Mapbox route map: 2D (flat streets) or 3D (tilted satellite with terrain). Shows the car route and the walking route. */
export default function MapboxRoute({ route, walk, drive, place, mode, center }: { route: SharedRoute | null; walk: Walk | null; drive: Walk | null; place: Place | null; mode: '2d' | '3d'; center?: [number, number] }) {
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<mapboxgl.Map | null>(null)
  const markers = useRef<mapboxgl.Marker[]>([])
  const [err, setErr] = useState('')
  const dest: [number, number] = place ? [place.lng, place.lat] : route ? [route.to[1], route.to[0]] : (center ?? [84.5, 26.8])

  // (re)create the map when the mode changes: the base style differs between 2D and 3D
  useEffect(() => {
    if (!box.current) return
    if (!MAPBOX_TOKEN) { setErr('Mapbox token is not configured (Mapbox_token in .env).'); return }
    mapboxgl.accessToken = MAPBOX_TOKEN
    const m = new mapboxgl.Map({
      container: box.current,
      style: mode === '3d' ? 'mapbox://styles/mapbox/satellite-streets-v12' : 'mapbox://styles/mapbox/streets-v12',
      center: route ? [(route.from[1] + dest[0]) / 2, (route.from[0] + dest[1]) / 2] : (center ?? [84.5, 26.8]), zoom: route ? 12 : 9,
      pitch: mode === '3d' ? 62 : 0, bearing: mode === '3d' ? -20 : 0,
    })
    map.current = m
    m.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), 'top-right')
    m.on('error', e => { const msg = (e as any).error?.message; if (msg) setErr(String(msg)) })
    m.on('style.load', () => {
      if (mode === '3d') {
        m.addSource('mapbox-dem', { type: 'raster-dem', url: 'mapbox://mapbox.mapbox-terrain-dem-v1', tileSize: 512, maxzoom: 14 })
        m.setTerrain({ source: 'mapbox-dem', exaggeration: 1.6 })
        m.addLayer({ id: 'sky', type: 'sky', paint: { 'sky-type': 'atmosphere', 'sky-atmosphere-sun-intensity': 12 } } as any)
      }
      // walking route first (underneath), then the car route on top
      m.addSource('walk', { type: 'geojson', data: line([]) })
      m.addLayer({ id: 'walk-casing', type: 'line', source: 'walk', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 7 } })
      m.addLayer({ id: 'walk-line', type: 'line', source: 'walk', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#1769e0', 'line-width': 4, 'line-dasharray': [0.6, 1.4] } })
      m.addSource('drive', { type: 'geojson', data: line([]) })
      m.addLayer({ id: 'drive-casing', type: 'line', source: 'drive', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 10 } })
      m.addLayer({ id: 'drive-line', type: 'line', source: 'drive', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#12805c', 'line-width': 6 } })
      m.fire('jn-ready' as any)
    })
    return () => { markers.current.forEach(x => x.remove()); markers.current = []; m.remove(); map.current = null }
  }, [mode, route]) // eslint-disable-line react-hooks/exhaustive-deps

  // route lines + markers follow the resolved place and the routes
  useEffect(() => {
    const m = map.current
    if (!m || !route) return
    const apply = () => {
      const w = m.getSource('walk') as mapboxgl.GeoJSONSource | undefined
      const d = m.getSource('drive') as mapboxgl.GeoJSONSource | undefined
      if (!w || !d) return
      const wc = (walk?.path ?? []) as [number, number][], dc = (drive?.path ?? []) as [number, number][]
      w.setData(line(wc)); d.setData(line(dc))
      markers.current.forEach(x => x.remove()); markers.current = []
      const mk = (lngLat: [number, number], color: string, label: string) => {
        const el = document.createElement('div')
        el.style.cssText = `background:${color};color:#fff;font:600 12px Inter,sans-serif;padding:4px 8px;border-radius:999px;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35);white-space:nowrap;max-width:200px;overflow:hidden;text-overflow:ellipsis`
        el.textContent = label
        markers.current.push(new mapboxgl.Marker({ element: el, anchor: 'bottom' }).setLngLat(lngLat).addTo(m))
      }
      mk([route.from[1], route.from[0]], '#d98a18', route.v)
      mk(dest, '#12805c', place?.name || route.shelter)
      const b = new mapboxgl.LngLatBounds([route.from[1], route.from[0]], dest)
      wc.forEach(c => b.extend(c)); dc.forEach(c => b.extend(c))
      m.fitBounds(b, { padding: 70, duration: 700, pitch: mode === '3d' ? 62 : 0, maxZoom: 16 })
    }
    if (m.getSource('walk')) apply(); else m.once('jn-ready' as any, apply)
  }, [walk, drive, place, mode, route]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <div ref={box} style={{ position: 'absolute', inset: 0 }} />
      {err && <div style={{ position: 'absolute', left: 8, right: 8, bottom: 8, background: 'rgba(255,255,255,.95)', color: '#8a1c1c', padding: '6px 10px', borderRadius: 8, fontSize: 12 }}>{err}</div>}
      {route && (walk || drive) && (
        <div style={{ position: 'absolute', left: 8, bottom: 22, zIndex: 2, background: 'rgba(255,255,255,.94)', color: '#1b2a24', font: '600 12px Inter,sans-serif', padding: '6px 10px', borderRadius: 10, boxShadow: '0 2px 8px rgba(0,0,0,.25)', display: 'grid', gap: 3 }}>
          {drive && <span><b style={{ color: '#12805c' }}>━ By car</b> {drive.km.toFixed(1)} km · {drive.minutes} min</span>}
          {walk && <span><b style={{ color: '#1769e0' }}>┅ On foot</b> {walk.km.toFixed(1)} km · {walk.minutes} min</span>}
        </div>
      )}
    </div>
  )
}

/**
 * The real routes for a village: the safe place's exact point (Google Maps via SerpAPI), then a car route and a walking route
 * along mapped roads and paths (Mapbox Directions).
 */
export function useRealRoute(route: SharedRoute | null) {
  const [state, setState] = useState<RealRoutes & { place: Place | null; busy: boolean }>({ place: null, walk: null, drive: null, googleDrive: null, googleWalk: null, busy: false, note: '' })
  useEffect(() => {
    if (!route) { setState({ place: null, walk: null, drive: null, googleDrive: null, googleWalk: null, busy: false, note: '' }); return }
    const ac = new AbortController()
    setState({ place: null, walk: null, drive: null, googleDrive: null, googleWalk: null, busy: true, note: '' })
    ;(async () => {
      const found = await resolveSafePlace(route, ac.signal)
      if (ac.signal.aborted) return
      setState(s => ({ ...s, place: found }))
      const r = await computeRealRoute(route, found, ac.signal)
      if (!ac.signal.aborted) setState({ place: found, busy: false, ...r })
    })()
    return () => ac.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route?.from[0], route?.from[1], route?.to[0], route?.to[1], route?.shelter])
  return state
}

/** The live-map overlay: the selected village's car and walking routes on a Mapbox 2D or 3D map. */
export function MapboxLive({ route, mode, center }: { route: SharedRoute | null; mode: '2d' | '3d'; center: [number, number] }) {
  const { place, walk, drive, note } = useRealRoute(route)
  return (
    <div className="mbx-live" style={{ position: 'absolute', inset: 0, zIndex: 1 }}>
      {/* keep the three-dots button clear: the zoom / compass controls sit lower on the live map */}
      <style>{'.mbx-live .mapboxgl-ctrl-top-right{top:70px;right:6px}'}</style>
      <MapboxRoute route={route} walk={walk} drive={drive} place={place} mode={mode} center={center} />
      <div style={{ position: 'absolute', left: '50%', bottom: 84, transform: 'translateX(-50%)', zIndex: 2, background: 'rgba(255,255,255,.94)', color: '#1b2a24', font: '500 12px Inter,sans-serif', padding: '6px 12px', borderRadius: 999, boxShadow: '0 2px 8px rgba(0,0,0,.25)', maxWidth: '86vw', textAlign: 'center' }}>
        {!route ? 'Select a village on the map to see its route here.' : place ? `${route.v} → ${place.name} · ${place.source === 'google-maps' ? 'exact place from Google Maps' : 'predicted place'}${note ? ' · ' + note : ''}` : 'Finding the safe place…'}
      </div>
    </div>
  )
}
