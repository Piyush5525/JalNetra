// The 26 August 2026 Langtang Lirung glacier collapse, told minute by minute from the official timeline
// (DHM / Flood Forecasting Division, USGS, Nepali Times, PTI) on a river traced from the Copernicus DEM.
import { useEffect, useMemo, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
import { FlyToInterpolator, WebMercatorViewport, type MapViewState } from '@deck.gl/core'
import { BitmapLayer, GeoJsonLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { TileLayer } from '@deck.gl/geo-layers'
import { FiArrowLeft, FiArrowRight, FiPlay, FiActivity } from 'react-icons/fi'
import gsap from 'gsap'
import A from '../aug.json'
import D from '../data.json'
import { countryBorders as countries } from '../countryBorders'
import s2 from '../img/s2.jpg'
import before from '../img/aug_before.jpg'
import after from '../img/aug_after.jpg'
import valley from '../img/aug_valley.jpg'

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", Helvetica, Arial, sans-serif'
const S2B = ((D as any).s2bounds ?? D.bounds) as [number, number, number, number]
const PATH = A.path as [number, number][]
const KM = A.km
const PL = Object.fromEntries(A.places.map(p => [p.id, p]))
const VALM = PL.vb.km
const mins = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m }
const WAVE = A.wave.map(([t, k]) => [mins(t as string), k as number])
const T0 = mins('08:37'), TEND = mins('16:00')
const hhmm = (t: number) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`
const waveKm = (t: number) => {
  if (t <= WAVE[0][0]) return 0
  for (let i = 1; i < WAVE.length; i++) if (t <= WAVE[i][0]) { const [t0, k0] = WAVE[i - 1], [t1, k1] = WAVE[i]; return k0 + (k1 - k0) * (t - t0) / (t1 - t0) }
  return WAVE[WAVE.length - 1][1]
}
const upTo = (k: number) => { const out: [number, number][] = []; for (let i = 0; i < PATH.length && KM[i] <= k; i++) out.push(PATH[i]); return out }
const ptAt = (k: number): [number, number] => { let j = 0; while (j < KM.length - 2 && KM[j + 1] < k) j++; const f = Math.min(Math.max((k - KM[j]) / Math.max(KM[j + 1] - KM[j], 1e-6), 0), 1); return [PATH[j][0] + (PATH[j + 1][0] - PATH[j][0]) * f, PATH[j][1] + (PATH[j + 1][1] - PATH[j][1]) * f] }
// when each gauge went offline (or hit its first alert), minutes after midnight NPT
const GAUGE_T: Record<string, { off?: number; alert?: number }> = { gy: { off: mins('08:44') }, sy: { off: mins('08:50') }, be: { off: mins('09:20') }, ml: { alert: mins('11:20'), off: mins('11:43') }, dg: {} }
const G = A.gauges.map(g => ({ ...PL[g.id], ...g }))

type Stat = { v: string; l: string }
type Step = { kicker: string; title: string; body: string; facts?: Stat[]; view: Partial<MapViewState> | 'fit' | 'india'; t: number; play?: [number, number]; images?: boolean; india?: boolean; end?: boolean }
const STEPS: Step[] = [
  { kicker: '26 August 2026 · 08:37', title: 'A glacier collapsed in Nepal', view: 'fit', t: T0 - 1,
    body: `Ice and rock broke off Langtang Lirung. The flood ran ${Math.round(VALM)} km down the Trishuli and Narayani rivers to the Indian border.`,
    facts: [{ v: 'Not rain', l: 'trigger' }, { v: `${Math.round(VALM)} km`, l: 'glacier to India' }, { v: '939', l: 'dead in Nepal' }] },
  { kicker: '08:37 · The collapse', title: 'A wall of ice fell 1.2 km', view: { longitude: 85.47, latitude: 28.275, zoom: 11.6 }, t: T0, images: true,
    body: 'About 0.2 km² of ice and rock dropped down the north face of the mountain. Seismometers recorded it as a magnitude 5.2 earthquake. Nepal\u2019s hydrology department says rain did not cause it.',
    facts: [{ v: '1.2 km', l: 'fall' }, { v: '0.2 km²', l: 'ice and rock' }, { v: 'M 5.2', l: 'seismic signal' }] },
  { kicker: '08:44 · Seven minutes later', title: '20 km in 7 minutes', view: { longitude: 85.42, latitude: 28.245, zoom: 10.4 }, t: T0, play: [T0, mins('08:52')],
    body: 'At 08:44 border CCTV at Gyirong Port saw the debris flow arrive. The Rasuwagadhi gauge read a calm 1.62 m at 08:40, then was destroyed.',
    facts: [{ v: '20 km', l: 'distance' }, { v: '7 min', l: 'time' }, { v: '~180 km/h', l: 'speed' }] },
  { kicker: '08:50 to 11:20 · The warning network', title: 'The gauges failed in silence', view: { longitude: 85.1, latitude: 27.95, zoom: 9.2 }, t: mins('08:52'), play: [mins('08:52'), mins('11:50')],
    body: 'Syabrubesi and Betrawati went offline while still reading normal, so no alarm was raised. The first alarm on the gauge network came at Malekhu, where the river rose almost 4 m in 10 minutes.',
    facts: [{ v: '08:50', l: 'first gauge lost' }, { v: '11:20', l: 'first alarm' }, { v: '2 h 43 min', l: 'after the collapse' }] },
  { kicker: '15:20 · Devghat', title: '6 h 43 min to reach Devghat', view: { longitude: 84.62, latitude: 27.79, zoom: 9.4 }, t: mins('11:50'), play: [mins('11:50'), TEND],
    body: 'The surge passed Mugling at 13:00 and met the Kali Gandaki at Devghat, forming the Narayani. It peaked at 6.57 m, under the 7.3 m amber level, so the last gauge never turned from green.',
    facts: [{ v: '188 km', l: 'from the glacier' }, { v: '15:20', l: 'arrived' }, { v: '6.57 m', l: 'peak (amber 7.3 m)' }] },
  { kicker: 'Into India', title: 'The water enters India at Valmikinagar', view: 'india', t: TEND, india: true,
    body: `At the barrage, ${Math.round(VALM)} km from the glacier, the Narayani becomes the Gandak and crosses the border into Bihar and Uttar Pradesh. All 36 gates were opened and Maharajganj and Kushinagar went on high alert. Dots are low villages within 3 km of the river.`,
    facts: [{ v: `${Math.round(VALM)} km`, l: 'glacier to border' }, { v: '1.04–1.42 lakh', l: 'cusecs, 8 to 10 pm (PTI)' }, { v: `${A.villages.length}`, l: 'low villages shown' }] },
  { kicker: 'Why JalNetra', title: 'A silent gauge should be the alarm', view: 'fit', t: TEND, end: true,
    body: 'Rain-driven river forecasts showed no flood at all that day, and the first official alarm came 2 h 43 min after the collapse. JalNetra treats gauges going dark as a flood front, follows it down the river, lists the low villages below it, and lets an operator approve a Hindi call to each village head.',
    facts: [{ v: '08:50', l: 'JalNetra flags the front' }, { v: '11:20', l: 'first official alarm' }, { v: '~2.5 h', l: 'earlier warning' }] },
]

export default function Story({ onHome, onRivers }: { onHome: () => void; onRivers: () => void; onLive: () => void }) {
  const [step, setStep] = useState(0)
  const [t, setT] = useState(STEPS[0].t)
  const [playing, setPlaying] = useState(false)
  const [img, setImg] = useState<'before' | 'after'>('after')
  const [view, setView] = useState<MapViewState>({ longitude: 84.7, latitude: 27.65, zoom: 7.6 })
  const panel = useRef<HTMLDivElement>(null)
  const playTo = useRef(0)

  const fit = (b: [number, number, number, number]) => {
    const w = innerWidth, left = w > 760 ? 470 : 20
    const v = new WebMercatorViewport({ width: w, height: innerHeight }).fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: { left, right: 40, top: 40, bottom: w > 760 ? 40 : innerHeight * 0.55 } })
    return { longitude: v.longitude, latitude: v.latitude, zoom: v.zoom }
  }
  const go = (k: number) => {
    const s = STEPS[k]; setStep(k); setT(s.t); setPlaying(false)
    const v = s.view === 'fit' ? fit([83.85, 27.15, 85.6, 28.36]) : s.view === 'india' ? fit([83.75, 26.82, 84.45, 27.62]) : { pitch: 0, bearing: 0, ...s.view }
    setView(x => ({ ...x, ...v, transitionDuration: 1600, transitionInterpolator: new FlyToInterpolator({ speed: 1.6 }) } as any))
    if (s.images) setImg('before')
    if (s.play) { playTo.current = s.play[1]; setTimeout(() => setPlaying(true), 1700) }
    if (s.images) setTimeout(() => setImg('after'), 2600)
  }
  useEffect(() => { go(0) }, [])
  useEffect(() => { if (panel.current) gsap.fromTo(panel.current.querySelectorAll('.anim'), { y: 10, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, stagger: 0.05, ease: 'power2.out' }) }, [step])
  // playback: one minute of the flood per 40 ms, faster in the long middle reach
  useEffect(() => {
    if (!playing) return
    let last = performance.now(), id = 0
    const span = playTo.current - STEPS[step].t, rate = span / 7000
    const tick = (now: number) => { const dt = (now - last) * rate; last = now; setT(x => { const n = x + dt; if (n >= playTo.current) { setPlaying(false); return playTo.current } return n }); id = requestAnimationFrame(tick) }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [playing, step])

  const S = STEPS[step]
  const wk = S.india || S.end ? VALM : waveKm(t)
  const layers = useMemo(() => {
    const L: any[] = [
      // satellite imagery everywhere, so zooming out never shows a patch on an empty canvas
      new TileLayer({ id: 'basemap', data: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', minZoom: 0, maxZoom: 17, tileSize: 256,
        renderSubLayers: (p: any) => { const b = p.tile.boundingBox; return new BitmapLayer(p, { data: undefined, image: p.data, bounds: [b[0][0], b[0][1], b[1][0], b[1][1]] }) } }),
      new GeoJsonLayer({ id: 'countries', data: countries as any, filled: false, stroked: true, getLineColor: [255, 255, 255, 150], lineWidthMinPixels: 1.2 }),
      new BitmapLayer({ id: 'valley', image: valley, bounds: A.img.valley as any }),
      new BitmapLayer({ id: 's2', image: s2, bounds: S2B }),
    ]
    if (S.images || step <= 2) L.push(new BitmapLayer({ id: 'src-img', image: img === 'after' ? after : before, bounds: A.img.after as any, opacity: S.images ? 1 : 0.85 }))
    L.push(new PathLayer({ id: 'river', data: [PATH], getPath: (d: any) => d, getColor: [125, 211, 252, 90], widthUnits: 'pixels', getWidth: 2.5, capRounded: true, jointRounded: true }))
    const wet = upTo(wk)
    if (wet.length > 1) {
      L.push(new PathLayer({ id: 'surge-glow', data: [wet], getPath: (d: any) => d, getColor: [56, 189, 248, 70], widthUnits: 'pixels', getWidth: 12, capRounded: true, jointRounded: true }))
      L.push(new PathLayer({ id: 'surge', data: [wet], getPath: (d: any) => d, getColor: [186, 230, 253, 255], widthUnits: 'pixels', getWidth: 4, capRounded: true, jointRounded: true }))
    }
    if (!S.india && !S.end && t >= T0 && wk < WAVE[WAVE.length - 1][1]) L.push(new ScatterplotLayer({ id: 'front', data: [ptAt(wk)], getPosition: (d: any) => d, getRadius: 11, radiusUnits: 'pixels', filled: false, stroked: true, getLineColor: [255, 255, 255, 240], lineWidthMinPixels: 2.5 }))
    const gState = (id: string) => { const g = GAUGE_T[id]; return g.off !== undefined && t >= g.off ? 'off' : g.alert !== undefined && t >= g.alert ? 'alert' : 'on' }
    L.push(new ScatterplotLayer({ id: 'gauges', data: G, getPosition: (d: any) => [d.lng, d.lat], radiusUnits: 'pixels', getRadius: 6, stroked: true, lineWidthMinPixels: 2,
      getFillColor: (d: any) => (gState(d.id) === 'off' ? [30, 34, 40] : gState(d.id) === 'alert' ? [245, 158, 11] : [255, 255, 255]), getLineColor: (d: any) => (gState(d.id) === 'off' ? [120, 128, 140] : [12, 14, 18]), updateTriggers: { getFillColor: t, getLineColor: t } }))
    L.push(new TextLayer({ id: 'glabels', data: G, getPosition: (d: any) => [d.lng, d.lat], getText: (d: any) => `${d.name} gauge${gState(d.id) === 'off' ? ' · offline' : gState(d.id) === 'alert' ? ' · alert' : ''}`, getSize: 12.5, getPixelOffset: (d: any) => (d.id === 'gy' ? [-12, 0] : [12, 0]), getTextAnchor: (d: any) => (d.id === 'gy' ? 'end' : 'start'),
      getColor: (d: any) => (gState(d.id) === 'off' ? [160, 168, 180] : [255, 255, 255]), fontFamily: FONT, fontWeight: 600, outlineWidth: 4, outlineColor: [0, 0, 0, 220], fontSettings: { sdf: true }, characterSet: 'auto', updateTriggers: { getText: t, getColor: t } }))
    const named = A.places.filter(p => ['src', 'mu', 'vb'].includes(p.id))
    L.push(new ScatterplotLayer({ id: 'places', data: named, getPosition: (d: any) => [d.lng, d.lat], radiusUnits: 'pixels', getRadius: 4, getFillColor: [125, 211, 252] }))
    L.push(new TextLayer({ id: 'plabels', data: named, getPosition: (d: any) => [d.lng, d.lat], getText: (d: any) => d.name, getSize: 13, getPixelOffset: [0, -16], getAlignmentBaseline: 'bottom', fontFamily: FONT, fontWeight: 650, getColor: [255, 255, 255], outlineWidth: 4, outlineColor: [0, 0, 0, 220], fontSettings: { sdf: true }, characterSet: 'auto' }))
    if (S.india) {
      const vb = PL.vb
      L.push(new ScatterplotLayer({ id: 'entry', data: [vb], getPosition: (d: any) => [d.lng, d.lat], radiusUnits: 'pixels', getRadius: 18, filled: false, stroked: true, getLineColor: [253, 224, 71, 255], lineWidthMinPixels: 3 }))
      L.push(new TextLayer({ id: 'entry-t', data: [{ p: [vb.lng, vb.lat + 0.075], t: 'NEPAL' }, { p: [vb.lng, vb.lat - 0.075], t: 'INDIA' }, { p: [vb.lng + 0.1, vb.lat], t: 'Water enters India here' }], getPosition: (d: any) => d.p, getText: (d: any) => d.t, getSize: 14, getColor: [13, 25, 18], background: true, getBackgroundColor: [253, 224, 71, 240], backgroundPadding: [7, 3], fontFamily: FONT, fontWeight: 700, fontSettings: { sdf: true }, characterSet: 'auto', getTextAnchor: (d: any) => (d.t.startsWith('Water') ? 'start' : 'middle') }))
      L.push(new ScatterplotLayer({ id: 'villages', data: A.villages, getPosition: (d: any) => [d.lng, d.lat], radiusUnits: 'pixels', getRadius: 6, getFillColor: [245, 158, 11], stroked: true, getLineColor: [12, 14, 18], lineWidthMinPixels: 1.5, pickable: true }))
      L.push(new TextLayer({ id: 'vlabels', data: A.villages.filter((_, i) => i % 3 === 0), getPosition: (d: any) => [d.lng, d.lat], getText: (d: any) => d.n, getSize: 11.5, getPixelOffset: [9, 0], getTextAnchor: 'start', fontFamily: FONT, fontWeight: 600, getColor: [253, 230, 138], outlineWidth: 4, outlineColor: [0, 0, 0, 220], fontSettings: { sdf: true }, characterSet: 'auto' }))
    }
    return L
  }, [t, img, step, wk])

  return (
    <div className="app">
      <DeckGL viewState={view} onViewStateChange={(e: any) => setView(e.viewState)} controller={true} layers={layers}
        getTooltip={({ object, layer }: any) => object && layer?.id === 'villages' ? { text: `${object.n} · ${object.dr} km from the river, about ${object.h} m above it` } : null} />
      <aside className="story story-lite" ref={panel}>
        <div className="sprog">{STEPS.map((_, k) => <button key={k} aria-label={`Go to step ${k + 1}`} className={k <= step ? 'on' : ''} onClick={() => go(k)} />)}</div>
        <div className="kicker anim">{S.kicker}</div>
        <h2 className="anim">{S.title}</h2>
        <p className="sbody anim">{S.body}</p>
        {S.images && <div className="seg anim augseg" aria-label="Satellite image"><button className={img === 'before' ? 'on' : ''} onClick={() => setImg('before')}>15 Dec 2025</button><button className={img === 'after' ? 'on' : ''} onClick={() => setImg('after')}>28 Sep 2026</button></div>}
        {S.facts && <div className="sstats anim">{S.facts.map(f => <div key={f.l} className="sstat"><b>{f.v}</b><span>{f.l}</span></div>)}</div>}
        <div className="sdate">26 Aug 2026 · {hhmm(S.india || S.end ? TEND : Math.max(t, T0 - 1))} Nepal time{playing ? ' · playing' : ''}
          {S.play && !playing && <button className="link replay" onClick={() => { setT(S.t); playTo.current = S.play![1]; setPlaying(true) }}><FiPlay /> Replay</button>}</div>
        <div className="snav">
          <button onClick={() => (step === 0 ? onHome() : go(step - 1))}><FiArrowLeft /> Back</button>
          {step < STEPS.length - 1 ? <button className="primary" onClick={() => go(step + 1)}>Next <FiArrowRight /></button> : <button className="primary" onClick={onRivers}><FiActivity /> See it live</button>}
        </div>
        {S.end && <button className="link" onClick={() => go(0)}>Replay the story</button>}
        <div className="lsrc">Timeline: Nepal DHM Flood Forecasting Division, Nepali Times, USGS, PTI. Images: Sentinel-2 (ESA Copernicus). River: traced on Copernicus DEM.</div>
      </aside>
    </div>
  )
}
