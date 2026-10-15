import { useEffect, useMemo, useRef, useState } from 'react'
import gsap from 'gsap'
import DeckGL from '@deck.gl/react'
import { FlyToInterpolator, LinearInterpolator, WebMercatorViewport, type MapViewState, type PickingInfo } from '@deck.gl/core'
import { BitmapLayer, GeoJsonLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { TileLayer, TripsLayer } from '@deck.gl/geo-layers'
import { PathStyleExtension } from '@deck.gl/extensions'
import { FiPlay, FiPause, FiSkipBack, FiSkipForward, FiX, FiNavigation, FiVolume2, FiArrowRight, FiArrowLeft, FiMap, FiList, FiCheckCircle, FiRotateCcw } from 'react-icons/fi'
import D from './data.json'
import s2 from './img/s2.jpg'
import o1 from './img/o1.png'
import o2 from './img/o2.png'
import o3 from './img/o3.png'
import corridorImg from './img/corridor.png'
import normalImg from './img/normal.png'
import countries from './countries.json'
import OpsPanel, { useIncidents } from './OpsPanel'
import type { Incident } from './ops'
import { BentoGrid, BentoGridItem } from './components/ui/bento-grid'
import { Spotlight } from './components/ui/spotlight'
import { AppBrand } from './components/AppBrand'
import { API } from './ops'
import { useFloodSpreadMapLayer } from './floodSpread'

type V = (typeof D.villages)[number]
type State = 'affected' | 'atrisk' | 'watch' | 'safe'
type Mode = 'early' | 'active' | 'today'
const OBS_IMG: Record<string, string> = { o1, o2, o3 }
const BOUNDS = D.bounds as [number, number, number, number]
const S2B = ((D as any).s2bounds ?? D.bounds) as [number, number, number, number]
const START = Date.parse(D.start)
const DAYS = D.days
const dayOf = (iso: string) => (Date.parse(iso) - START) / 864e5
const OBS = D.obs.map(o => ({ ...o, day: dayOf(o.time) }))
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", Helvetica, Arial, sans-serif'
const fmtDay = (d: number) => new Date(START + Math.floor(d) * 864e5).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
const fmtTime = (iso: string) => {
  const t = new Date(iso)
  return `${t.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })} · ${t.toISOString().slice(11, 16)} UTC`
}
const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' })
const STATE_LABEL: Record<State, string> = { affected: 'Affected', atrisk: 'At risk', watch: 'Watch', safe: 'Safe' }
const STATE_RGB: Record<State, [number, number, number]> = { affected: [56, 189, 248], atrisk: [245, 158, 11], watch: [253, 224, 71], safe: [148, 163, 184] }
const st = D.river.stations
const interpQ = (q: number[], t: number) => { const i = Math.max(0, Math.min(Math.floor(t), q.length - 2)); const f = Math.min(Math.max(t - i, 0), 1); return q[i] * (1 - f) + q[i + 1] * f }
const baseQ = st.map(s => Math.min(...s.q.slice(0, 10)))
const ratioAt = (i: number, t: number) => Math.max(0, Math.min(1, (interpQ(st[i].q, t) - baseQ[i]) / (st[i].peakQ - baseQ[i])))
const riverPt = (km: number): [number, number] => {
  const K = D.river.km, P = D.river.path as [number, number][]
  let j = 0; while (j < K.length - 2 && K[j + 1] < km) j++
  const f = Math.min(Math.max((km - K[j]) / Math.max(K[j + 1] - K[j], 1e-6), 0), 1)
  return [P[j][0] + (P[j + 1][0] - P[j][0]) * f, P[j][1] + (P[j + 1][1] - P[j][1]) * f]
}
// furthest-downstream river point where flow is at least 80% of the way from its base to its event peak
const waveKm = (t: number) => { let k = 0; st.forEach((s, i) => { if (ratioAt(i, t) >= 0.8) k = Math.max(k, s.km) }); return k }
const nearestStation = (c: [number, number]) => {
  const P = D.river.path as [number, number][]; let bi = 0, bd = 1e9
  P.forEach((p, i) => { const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2; if (d < bd) { bd = d; bi = i } })
  const km = D.river.km[bi]; let si = 0; st.forEach((s, i) => { if (Math.abs(s.km - km) < Math.abs(st[si].km - km)) si = i })
  return { km, si }
}
const rainAt = (t: number) => D.rain.points.map(p => p.p[Math.min(Math.floor(t), p.p.length - 1)])

const LIVE = (D as any).live as { fetched: string; today: string; level: 'none' | 'watch' | 'warning'; reasons: string[]; nextPasses: string[]; rain: { lng: number; lat: number; next7: number }[]; stations: { name: string; label: string; time: string[]; q: number[]; qmax: number[]; qmin: number[]; today: number; fmax: number; eventPeak: number }[] }
const LATEST = OBS.length - 1
async function fetchLive(): Promise<typeof LIVE | null> {
  try {
    const S = LIVE.stations
    const pts = [[27.725006, 84.375], [27.575005, 84.07501], [26.975006, 84.125], [26.475006, 84.475006], [25.975006, 84.975006], [25.875, 85.07501], [25.775002, 85.125]]
    const fu = `${API}/proxy/flood?latitude=${pts.map(p => p[0]).join(',')}&longitude=${pts.map(p => p[1]).join(',')}&daily=river_discharge,river_discharge_max,river_discharge_min&past_days=7&forecast_days=10`
    const ru = `${API}/proxy/forecast?latitude=${LIVE.rain.map(r => r.lat).join(',')}&longitude=${LIVE.rain.map(r => r.lng).join(',')}&daily=precipitation_sum&forecast_days=7&timezone=UTC`
    const [f, r] = await Promise.all([fetch(fu).then(x => x.json()), fetch(ru).then(x => x.json())])
    const today = new Date().toISOString().slice(0, 10)
    const stations = S.map((s, i) => { const d = f[i].daily; const ti = Math.max(0, d.time.indexOf(today)); return { ...s, time: d.time, q: d.river_discharge, qmax: d.river_discharge_max, qmin: d.river_discharge_min, today: ti, fmax: Math.max(...d.river_discharge_max.slice(ti + 1)) } })
    const rain = LIVE.rain.map((p, i) => ({ ...p, next7: Math.round(r[i].daily.precipitation_sum.reduce((a: number, b: number) => a + b, 0) * 10) / 10 }))
    let level: 'none' | 'watch' | 'warning' = 'none'
    stations.forEach(s => { if (s.fmax >= 0.8 * s.eventPeak) level = 'warning'; else if (level === 'none' && s.fmax > s.q[s.today] * 1.15) level = 'watch' })
    const h = stations[stations.length - 1], mx = Math.max(...rain.map(x => x.next7))
    const falling = stations.every(s => s.q[s.today] <= s.q[Math.max(0, s.today - 3)])
    const reasons = [
      `${h.label} ${Math.round(h.q[h.today]).toLocaleString()} m³/s today${falling ? ', river falling at all points' : ''}`,
      `Highest forecast at ${h.label} in the next 10 days: ${Math.round(h.fmax).toLocaleString()} m³/s`,
      `Rain forecast for the Nepal catchment: at most ${mx} mm over the next 7 days`,
    ]
    return { ...LIVE, fetched: new Date().toISOString(), today, stations, rain, level, reasons }
  } catch { return null }
}
function villageState(v: V, mode: Mode, obsIdx: number): State {
  if (mode === 'today') obsIdx = LATEST
  if (mode !== 'early' && obsIdx >= 0) {
    const d = (v.obs as Record<string, number | null>)[OBS[obsIdx].id]
    if (d !== null && d !== undefined && d <= 0.5) return 'affected'
  }
  if (v.inCorr) return 'atrisk'
  if (v.corrDist <= 2) return 'watch'
  return 'safe'
}


// ---------- the guided story: every number below is computed from the bundled data ----------
const rainPeak = (() => { let best = { mm: 0, day: 0 }; D.rain.points.forEach(p => p.p.forEach((v, i) => { if (v > best.mm) best = { mm: v, day: i } })); return best })()
const rainTotal = (from: number, to: number) => Math.round(Math.max(...D.rain.points.map(p => p.p.slice(from, to + 1).reduce((a, b) => a + b, 0))))
const O2 = OBS.find(o => o.id === 'o2')!
const o2Idx = OBS.indexOf(O2)
const o2Counts = (() => { const c: Record<State, number> = { affected: 0, atrisk: 0, watch: 0, safe: 0 }; D.villages.forEach(v => c[villageState(v, 'active', o2Idx)]++); return c })()
const SPOT = D.villages.find(v => v.id === (D as any).spotlight) ?? D.villages[0]
type Step = { title: string; kicker: string; body: string; facts?: [string, string][]; view?: Partial<MapViewState> | 'fit'; t: number; mode: Mode; layers: Partial<Record<'observed' | 'route' | 'corridor' | 'villages' | 'roads' | 'shelters', boolean>>; normal?: boolean; select?: number; play?: { from: number; to: number }; chart?: number; legend?: boolean; rain?: boolean; today?: boolean }
const STEPS: Step[] = [
  { kicker: '2026 flood · historical validation', title: 'The Gandak, from Nepal to Bihar', t: 0, mode: 'early', view: 'fit',
    layers: { route: true, villages: false, corridor: false, observed: false, roads: false, shelters: false },
    body: `The Gandak starts in Nepal\u2019s Himalaya, becomes the Narayani at Devghat and enters Bihar at Valmikinagar barrage, flowing ${Math.round(st[st.length - 1].km)} km to Hajipur on the Ganga. Everything here is real data: satellite imagery, river flow and radar flood maps.`,
    facts: [['Imagery', 'Sentinel-2 satellite mosaic'], ['River line', 'OpenStreetMap'], ['Villages tracked', `${D.villages.length}`]] },
  { kicker: 'Step 1 · The signal', title: 'Heavy rain falls in Nepal', t: rainPeak.day, mode: 'early', view: { longitude: 83.85, latitude: 27.85, zoom: 8.4 },
    layers: { route: true, villages: false, corridor: false, observed: false }, rain: true,
    body: 'Between 24 and 27 September, storms dropped heavy rain on the hills of Lumbini and Gandaki provinces. The circles show daily rain at four points in the catchment.',
    facts: [['Heaviest day', `${Math.round(rainPeak.mm)} mm on ${fmtDay(rainPeak.day).slice(0, 6)}`], ['4-day total', `up to ${rainTotal(9, 12)} mm`], ['Source', 'Open-Meteo daily rainfall']] },
  { kicker: 'Step 2 · The river reacts', title: 'The Narayani rises at Devghat', t: st[0].peakDay, mode: 'early', view: { longitude: st[0].lng, latitude: st[0].lat, zoom: 9.2, pitch: 30 },
    layers: { route: true, villages: false, corridor: false, observed: false }, chart: 0,
    body: `A day after the heaviest rain, flow at Devghat more than doubled. The brighter and thicker the moving particles on the river, the more water is flowing.`,
    facts: [['Before', `${Math.round(Math.min(...st[0].q.slice(0, 11))).toLocaleString()} m\u00b3/s`], ['Peak', `${Math.round(st[0].peakQ).toLocaleString()} m\u00b3/s on ${fmtDay(st[0].peakDay).slice(0, 6)}`], ['Source', 'GloFAS river model, daily']] },
  { kicker: 'Step 3 · The wave travels', title: 'The flood wave moves downstream', t: st[0].peakDay - 1, mode: 'early', view: undefined,
    layers: { route: true, villages: false, corridor: false, observed: false }, play: { from: st[0].peakDay - 1, to: st[st.length - 1].peakDay + 0.6 },
    body: 'Watch the white ring: it marks the furthest point where the river is close to its peak. The camera follows it from Nepal into Bihar, one day every 1.6 seconds.',
    facts: st.map(s => [s.label, `peak ${fmtDay(s.peakDay).slice(0, 6)}`] as [string, string]) },
  { kicker: 'Step 4 · Satellite proof', title: 'Radar sees the flood', t: O2.day + 0.01, mode: 'active', view: { longitude: 84.2, latitude: 26.88, zoom: 9.3 },
    layers: { route: true, villages: false, corridor: false, observed: true },
    body: `On ${fmtTime(O2.time)} the Sentinel-1 radar satellite passed overhead. Radar sees through cloud, so it maps flooding even during the monsoon. Blue is land that was dry on 17 September and under water now.`,
    facts: [['New water', `${O2.km2.toLocaleString()} km\u00b2`], ['Where', O2.place.replace('Gandak floodplain near ', 'Around ')], ['Compared with', 'Radar pass of 17 Sep']] },
  { kicker: 'Step 5 · What got flooded', title: 'Normal river versus flood water', t: O2.day + 0.01, mode: 'active', view: { longitude: 84.27, latitude: 26.8, zoom: 10.2 },
    layers: { route: false, villages: false, corridor: false, observed: true }, normal: true,
    body: 'White is where the river normally flows (water seen most of the time since 1984). Blue is extra water from this flood only. Land cover maps then show what the flood water covered: mostly farmland.',
    facts: [['Normal river', 'JRC Global Surface Water, 1984\u20132021'], ['Cropland flooded', `${(O2 as any).cropKm2?.toLocaleString() ?? '\u2013'} km\u00b2`], ['Land cover', 'ESA WorldCover 2021, 10 m']] },
  { kicker: 'Step 6 · Who is at risk', title: 'Villages along the corridor', t: O2.day + 0.01, mode: 'active', view: 'fit',
    layers: { route: true, villages: true, corridor: true, observed: true }, legend: true,
    body: `The amber outline is JalNetra\u2019s predicted risk corridor: land within 12 km of the river and less than 5 m above it. Each dot is a village, coloured by what the data shows.`,
    facts: [['Affected', `${o2Counts.affected} villages, radar saw water within 500 m`], ['At risk', `${o2Counts.atrisk} more inside the corridor`], ['Watch', `${o2Counts.watch} within 2 km of it`]] },
  { kicker: 'Step 7 · The warning', title: `Calling ${SPOT.name}`, t: O2.day + 0.01, mode: 'active', view: { longitude: SPOT.lng, latitude: SPOT.lat, zoom: 10.8 },
    layers: { route: true, villages: true, corridor: true, observed: true }, select: SPOT.id,
    body: `${SPOT.name} in ${SPOT.district} district had flood water at the village on 29 September. JalNetra writes the warning in Hindi and reads it out, so it works on any basic phone call.`,
    facts: [] },
  { kicker: 'Step 8 · Right now', title: 'The Gandak today', t: DAYS - 1, mode: 'today', view: 'fit',
    layers: { route: true, villages: true, corridor: true, observed: true }, today: true,
    body: 'JalNetra keeps watching after the flood. This is the live check: today\u2019s river model run, the rain forecast for Nepal and the most recent radar pass.',
    facts: [] },
  { kicker: 'The idea', title: 'From upstream signal to downstream village', t: O2.day + 0.01, mode: 'active', view: 'fit',
    layers: { route: true, villages: true, corridor: true, observed: true },
    body: 'Rain in Nepal, the river rising, the wave moving into Bihar, radar confirming the flood, and a warning reaching the village. Explore the map yourself to click any village or river stretch.',
    facts: [] },
]

const INITIAL: MapViewState = { longitude: 84.45, latitude: 26.85, zoom: 7.7, pitch: 0, bearing: 0, minZoom: 3.5, maxZoom: 15 }
const ESRI_IMAGERY = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
const CARTO_LIGHT = ['a', 'b', 'c', 'd'].map(s => `https://${s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png`)

export default function App({ start = 'story', incidentId = null, onHome, onValidate, onLive, onStory }: { start?: 'story' | 'explore' | 'ops'; incidentId?: string | null; onHome: () => void; onValidate: () => void; onLive: () => void; onStory: () => void }) {
  const [view, setView] = useState<MapViewState>(INITIAL)
  const [t, setT] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [follow, setFollow] = useState(false)
  const [mode, setMode] = useState<Mode>('early')
  const [sat, setSat] = useState(true)
  const [layers, setLayers] = useState({ observed: true, route: true, corridor: true, villages: true, roads: false, shelters: false })
  const [sel, setSel] = useState<V | null>(null)
  const [reach, setReach] = useState<{ km: number; si: number } | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [anim, setAnim] = useState(0)
  const [phase, setPhase] = useState<'landing' | 'story' | 'explore' | 'ops'>(start)
  const inc = useIncidents()
  const [opsSel, setOpsSel] = useState<string | null>(incidentId)
  const [floodSpreadHorizon, setFloodSpreadHorizon] = useState<0 | 3 | 6 | 12 | 24 | null>(null)
  const [step, setStep] = useState(0)
  const [normalOn, setNormalOn] = useState(false)
  const [intro, setIntro] = useState(true)
  const [live, setLive] = useState<typeof LIVE>(LIVE)
  const landingRef = useRef<HTMLDivElement>(null)
  useEffect(() => { fetchLive().then(l => { if (l) setLive(l) }) }, [])
  const playTo = useRef<number | null>(null)

  // particle clock
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    let last = performance.now(), id = 0
    const tick = (now: number) => { setAnim(a => (a + (now - last) * 0.9) % 4000); last = now; id = requestAnimationFrame(tick) }
    id = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(id)
  }, [])
  // timeline playback: one day every 1.6 s
  useEffect(() => {
    if (!playing) return
    let last = performance.now(), id = 0
    const step = (now: number) => {
      const dt = (now - last) / 1600; last = now
      setT(x => { const end = playTo.current ?? DAYS - 1; const n = x + dt; if (n >= end) { setPlaying(false); playTo.current = null; return end } return n })
      id = requestAnimationFrame(step)
    }
    id = requestAnimationFrame(step)
    return () => cancelAnimationFrame(id)
  }, [playing])

  const obsIdx = useMemo(() => { let k = -1; OBS.forEach((o, i) => { if (o.day <= t) k = i }); return k }, [t])
  useEffect(() => { if (playing && obsIdx >= 1 && mode === 'early') setMode('active') }, [obsIdx, mode, playing])

  // Landing motion is deliberately small: a staged reveal and one downstream signal.
  useEffect(() => {
    if (phase !== 'landing' || !landingRef.current) return
    const root = landingRef.current
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const ctx = gsap.context(() => {
      if (reduce) {
        gsap.set('.landing-reveal', { opacity: 1, y: 0 })
        gsap.set('.landing-flow-bead', { left: '94%' })
        return
      }
      gsap.timeline({ defaults: { ease: 'power3.out' } })
        .from('.landing-kicker', { opacity: 0, y: 10, duration: 0.45 })
        .from('.landing-reveal', { opacity: 0, y: 18, duration: 0.65, stagger: 0.08 }, '-=.2')
        .from('.landing-proof', { opacity: 0, y: 12, duration: 0.45 }, '-=.25')
      gsap.to('.landing-flow-bead', { left: '94%', duration: 3.8, ease: 'sine.inOut', repeat: -1, yoyo: true, delay: 0.5 })
    }, root)
    return () => ctx.revert()
  }, [phase])
  const wkm = waveKm(t)
  const prevObs = useRef(-1)
  useEffect(() => {
    if (mode === 'active' && obsIdx >= 0 && obsIdx !== prevObs.current) { setAnalyzing(true); const id = setTimeout(() => setAnalyzing(false), 1300); prevObs.current = obsIdx; return () => clearTimeout(id) }
    prevObs.current = obsIdx
  }, [obsIdx, mode])

  // follow the water
  const lastFollow = useRef(-1)
  useEffect(() => {
    if (!follow) return
    const km = Math.max(wkm, 1)
    if (Math.abs(km - lastFollow.current) < 4) return
    lastFollow.current = km
    const [lng, lat] = riverPt(km)
    setView(v => ({ ...v, longitude: lng, latitude: lat, zoom: 9.1, pitch: 40, bearing: -12, transitionDuration: 1600, transitionInterpolator: new FlyToInterpolator({ speed: 1.3 }) }))
  }, [follow, wkm])
  const startFollow = () => {
    setFollow(true); setMode('early'); setT(0); setSel(null); lastFollow.current = 1
    const [lng, lat] = riverPt(1)
    setView(v => ({ ...v, longitude: lng, latitude: lat, zoom: 9, pitch: 40, bearing: -12, transitionDuration: 2200, transitionInterpolator: new FlyToInterpolator({ speed: 1.2 }) }))
    setTimeout(() => setPlaying(true), 2300)
  }
  const resetView = () => { setFollow(false); setView({ ...INITIAL, transitionDuration: 1200, transitionInterpolator: new LinearInterpolator(['longitude', 'latitude', 'zoom', 'pitch', 'bearing']) }) }

  const fit = (padLeft: number) => {
    const w = window.innerWidth, h = window.innerHeight
    const vp = new WebMercatorViewport({ width: w, height: h }).fitBounds([[BOUNDS[0], BOUNDS[1]], [BOUNDS[2], BOUNDS[3]]], { padding: { left: Math.min(padLeft, w * 0.45), right: 40, top: 70, bottom: 60 } })
    return { longitude: vp.longitude, latitude: vp.latitude, zoom: vp.zoom }
  }
  const fly = (v: Partial<MapViewState>, dur = 2000) => setView(cur => ({ ...cur, pitch: 0, bearing: 0, ...v, transitionDuration: dur, transitionInterpolator: new FlyToInterpolator({ speed: 1.2 }) }))
  useEffect(() => { setView(v => ({ ...v, ...fit(0) })); if (start === 'story') applyStep(0); else if (start === 'explore') explore() }, []) // eslint-disable-line
  const panelW = window.innerWidth > 760 ? 460 : 0
  const applyStep = (i: number) => {
    const s = STEPS[i]; setStep(i); setPlaying(false); setFollow(false); playTo.current = null; setSel(null); setReach(null)
    setLayers(l => ({ ...l, ...s.layers })); setNormalOn(!!s.normal); setMode(s.mode); setT(s.t)
    if (s.view === 'fit') fly({ ...fit(panelW) }); else if (s.view) fly(s.view)
    if (s.select) setSel(D.villages.find(v => v.id === s.select) ?? null)
    if (s.play) { playTo.current = s.play.to; setT(s.play.from); setFollow(true); lastFollow.current = -1; setTimeout(() => setPlaying(true), 1200) }
  }
  const selectInc = (i: Incident | null) => { setFloodSpreadHorizon(null); setOpsSel(i?.id ?? null); if (i) fly({ longitude: i.lng, latitude: i.lat, zoom: Math.max(view.zoom ?? 8, 9.5) }) }
  const openOps = () => { setPhase('ops'); setSel(null); setReach(null); setPlaying(false); setFollow(false); fly({ ...fit(0) }) }
  const startStory = () => { setPhase('story'); applyStep(0) }
  const explore = () => { setPhase('explore'); setStep(0); setLayers({ observed: true, route: true, corridor: true, villages: true, roads: false, shelters: false }); setNormalOn(false); setMode('active'); setT(OBS[1].day + 0.01); fly({ ...fit(0) }) }
  const states = useMemo(() => new Map(D.villages.map(v => [v.id, villageState(v, mode, obsIdx)])), [mode, obsIdx])
  const counts = useMemo(() => { const c: Record<State, number> = { affected: 0, atrisk: 0, watch: 0, safe: 0 }; states.forEach(s => c[s]++); return c }, [states])
  const floodSpreadLayer = useFloodSpreadMapLayer(phase === 'ops' ? floodSpreadHorizon : null)

  // flow particles: trips per river segment, brightness follows that segment's flow
  const trips = useMemo(() => {
    const out: { path: [number, number][]; ts: number[]; seg: number }[] = []
    const P = D.river.path as [number, number][], K = D.river.km
    for (let s = 0; s < st.length - 1; s++) {
      const idx = K.map((k, i) => (k >= st[s].km - 0.5 && k <= st[s + 1].km + 0.5 ? i : -1)).filter(i => i >= 0)
      if (idx.length < 2) continue
      for (let r = 0; r < 18; r++) {
        const off = (r / 18) * 4000
        out.push({ path: idx.map(i => P[i]), ts: idx.map(i => K[i] * 40 - off), seg: s })
      }
    }
    return out
  }, [])

  const tq = Math.round(t * 20)
  const L: any[] = []
  // Explore and operations get a real, zoomable basemap (satellite or street map). The story keeps its original dark canvas.
  const showBase = phase === 'explore' || phase === 'ops'
  if (showBase) L.push(new TileLayer({ id: 'basemap', data: sat ? ESRI_IMAGERY : CARTO_LIGHT, minZoom: 0, maxZoom: 17, tileSize: 256,
    renderSubLayers: (p: any) => { const b = p.tile.boundingBox; return new BitmapLayer(p, { data: undefined, image: p.data, bounds: [b[0][0], b[0][1], b[1][0], b[1][1]] }) } }))
  L.push(new GeoJsonLayer({ id: 'countries', data: countries as any, filled: !showBase, stroked: true, getFillColor: [16, 19, 24], getLineColor: showBase ? (sat ? [255, 255, 255, 90] : [60, 70, 64, 150]) : [70, 78, 92], lineWidthMinPixels: 1, updateTriggers: { getLineColor: [showBase, sat] } }))
  L.push(new PathLayer({ id: 'network-map', data: D.network, getPath: (d: any) => d, getColor: showBase && !sat ? [29, 111, 184, 150] : [70, 110, 150], widthMinPixels: 1, updateTriggers: { getColor: [showBase, sat] } }))
  if (sat && !showBase) L.push(new BitmapLayer({ id: 's2', image: s2, bounds: S2B }))
  if (normalOn) L.push(new BitmapLayer({ id: 'normal', image: normalImg, bounds: BOUNDS, opacity: 0.9 }))
  if (layers.corridor) L.push(new BitmapLayer({ id: 'corridor', image: corridorImg, bounds: BOUNDS, opacity: sat ? 0.7 : 0.8 }))
  if (layers.roads) L.push(new PathLayer({
    id: 'roads', data: D.roads, getPath: (d: any) => d.path, getColor: (d: any) => (d.cut ? [245, 158, 11, 240] : [226, 232, 240, sat ? 140 : 100]), getWidth: (d: any) => (d.cut ? 3 : 1.2), widthUnits: 'pixels',
    getDashArray: (d: any) => (d.cut ? [3, 2] : [0, 0]), dashJustified: true, extensions: [new PathStyleExtension({ dash: true })], pickable: true, updateTriggers: { getColor: sat },
  }))
  const shownObs = mode === 'today' ? LATEST : mode === 'active' ? obsIdx : -1
  if (layers.observed && shownObs >= 0) L.push(new BitmapLayer({ id: 'obs-' + OBS[shownObs].id, image: OBS_IMG[OBS[shownObs].id], bounds: BOUNDS, opacity: 0.82 }))
  if (layers.route) {
    L.push(new PathLayer({ id: 'river-base', data: [{ path: D.river.path }], getPath: (d: any) => d.path, getColor: [186, 230, 253, 45], widthUnits: 'pixels', getWidth: 4, capRounded: true, jointRounded: true, pickable: true, onClick: (i: PickingInfo) => { if (i.coordinate) { setReach(nearestStation(i.coordinate as [number, number])); setSel(null) } } }))
    for (const k of [0, 2000]) L.push(new TripsLayer({
      id: 'flow' + k, data: trips, getPath: (d: any) => d.path, getTimestamps: (d: any) => d.ts,
      getColor: (d: any) => { const r = ratioAt(d.seg, t); return [224, 242, 254, Math.round(60 + 195 * r)] },
      getWidth: (d: any) => 1.5 + 2.5 * ratioAt(d.seg, t), widthUnits: 'pixels', trailLength: 260, currentTime: (anim + k) % 4000 + 2000, fadeTrail: true, capRounded: true,
      updateTriggers: { getColor: tq, getWidth: tq },
    }))
  }
  if (phase === 'story' ? STEPS[step].rain : phase === 'explore' && mode === 'early') {
    const rr = rainAt(t), rd = D.rain.points.map((p, i) => ({ ...p, mm: rr[i] }))
    L.push(new ScatterplotLayer({ id: 'rain', data: rd, getPosition: (d: any) => [d.lng, d.lat], getRadius: (d: any) => 3000 + d.mm * 120, stroked: true, getFillColor: [147, 197, 253, 35], getLineColor: [191, 219, 254, 210], lineWidthMinPixels: 1, updateTriggers: { getRadius: Math.floor(t) } }))
    L.push(new TextLayer({ id: 'rain-t', data: rd, getPosition: (d: any) => [d.lng, d.lat], getText: (d: any) => (d.mm >= 1 ? `${Math.round(d.mm)} mm` : ''), getSize: 14, getColor: [224, 242, 254], fontFamily: FONT, fontWeight: 600, outlineWidth: 3, outlineColor: [0, 0, 0, 200], fontSettings: { sdf: true }, updateTriggers: { getText: Math.floor(t) } }))
  }
  if (mode === 'today') {
    L.push(new ScatterplotLayer({ id: 'rainf', data: live.rain, getPosition: (d: any) => [d.lng, d.lat], getRadius: (d: any) => 3000 + d.next7 * 120, stroked: true, getFillColor: [147, 197, 253, 25], getLineColor: [191, 219, 254, 170], lineWidthMinPixels: 1 }))
    L.push(new TextLayer({ id: 'rainf-t', data: live.rain, getPosition: (d: any) => [d.lng, d.lat], getText: (d: any) => `${Math.round(d.next7)} mm next 7 days`, getSize: 12, getColor: [224, 242, 254], fontFamily: FONT, fontWeight: 600, outlineWidth: 3, outlineColor: [0, 0, 0, 200], fontSettings: { sdf: true } }))
  }
  if (layers.shelters) L.push(new ScatterplotLayer({ id: 'shelters', data: D.shelters, getPosition: (d: any) => [d.lng, d.lat], getRadius: 4.5, radiusUnits: 'pixels', getFillColor: [52, 211, 153], stroked: true, getLineColor: [6, 30, 22], lineWidthMinPixels: 1, pickable: true }))
  if (layers.villages) L.push(new ScatterplotLayer({
    id: 'villages', data: D.villages, getPosition: (d: V) => [d.lng, d.lat], radiusUnits: 'pixels',
    getRadius: (d: V) => (sel?.id === d.id ? 8 : states.get(d.id) === 'safe' ? 3.2 : 4.6),
    getFillColor: (d: V) => [...STATE_RGB[states.get(d.id)!], 240] as any, stroked: true, getLineColor: (d: V) => (sel?.id === d.id ? [255, 255, 255, 255] : [8, 10, 14, 220]), lineWidthMinPixels: 1.2,
    pickable: true, onClick: (i: PickingInfo) => { setSel(i.object as V); setReach(null); setFollow(false) },
    updateTriggers: { getFillColor: [mode, obsIdx], getRadius: [mode, obsIdx, sel?.id], getLineColor: sel?.id },
  }))
  if (layers.villages && (view.zoom ?? 0) >= 9.6) L.push(new TextLayer({ id: 'vlabels', data: D.villages.filter(v => states.get(v.id) !== 'safe'), getPosition: (d: V) => [d.lng, d.lat], getText: (d: V) => d.name, getSize: 11, getPixelOffset: [8, 0], getTextAnchor: 'start', getColor: [241, 245, 249, 230], fontFamily: FONT, fontWeight: 500, characterSet: 'auto', outlineWidth: 3, outlineColor: [0, 0, 0, 200], fontSettings: { sdf: true } }))
  const selSh = sel ? (sel as any).shelter : null
  if (selSh) {
    L.push(new PathLayer({ id: 'to-shelter', data: [{ path: [[sel!.lng, sel!.lat], [selSh.lng, selSh.lat]] }], getPath: (d: any) => d.path, getColor: [52, 211, 153, 230], getWidth: 2, widthUnits: 'pixels', getDashArray: [4, 3], dashJustified: true, extensions: [new PathStyleExtension({ dash: true })] }))
    L.push(new ScatterplotLayer({ id: 'shelter-sel', data: [selSh], getPosition: (d: any) => [d.lng, d.lat], getRadius: 7, radiusUnits: 'pixels', getFillColor: [52, 211, 153], stroked: true, getLineColor: [255, 255, 255], lineWidthMinPixels: 1.5 }))
  }
  L.push(new ScatterplotLayer({ id: 'stations', data: st, getPosition: (d: any) => [d.lng, d.lat], getRadius: 4.5, radiusUnits: 'pixels', getFillColor: [255, 255, 255], stroked: true, getLineColor: [15, 23, 42], lineWidthMinPixels: 1.5 }))
  L.push(new TextLayer({
    id: 'labels', data: [...st.map(s => ({ ...s, text: s.label })), ...D.regionLabels], getPosition: (d: any) => [d.lng, d.lat], getText: (d: any) => d.text,
    getSize: (d: any) => (d.region ? 12 : 13), getColor: (d: any) => (d.region ? [226, 232, 240, 190] : [255, 255, 255]), getPixelOffset: (d: any) => (d.region ? [0, 0] : [10, 0]),
    getTextAnchor: (d: any) => (d.region ? 'middle' : 'start'), fontFamily: FONT, fontWeight: 600, characterSet: 'auto', outlineWidth: 4, outlineColor: [0, 0, 0, 210], fontSettings: { sdf: true },
  }))
  if (layers.route && wkm > 0) {
    const [lng, lat] = riverPt(wkm)
    L.push(new ScatterplotLayer({ id: 'front', data: [{ p: [lng, lat] }], getPosition: (d: any) => d.p, getRadius: 10, radiusUnits: 'pixels', filled: false, stroked: true, getLineColor: [255, 255, 255, 230], lineWidthMinPixels: 2 }))
  }

  if (phase === 'ops') {
    for (let k = L.length - 1; k >= 0; k--) if (!['basemap', 'countries', 'network-map', 's2', 'river-base', 'flow0', 'flow2000', 'labels', 'stations'].includes(L[k].id)) L.splice(k, 1)
    if (floodSpreadLayer.length) L.push(...floodSpreadLayer)
    const SEV: Record<string, [number, number, number]> = { high: [248, 113, 113], medium: [245, 158, 11], low: [253, 224, 71] }
    L.push(new ScatterplotLayer({ id: 'incidents', data: inc.items, getPosition: (d: Incident) => [d.lng, d.lat], radiusUnits: 'pixels', getRadius: (d: Incident) => (d.id === opsSel ? 11 : 7),
      getFillColor: (d: Incident) => [...SEV[d.severity], ['verified', 'rejected'].includes(d.status) ? 90 : 240] as any, stroked: true, getLineColor: (d: Incident) => (d.id === opsSel ? [255, 255, 255] : [10, 12, 16]), lineWidthMinPixels: 1.5,
      pickable: true, onClick: (i: PickingInfo) => selectInc(i.object as Incident), updateTriggers: { getRadius: opsSel, getLineColor: opsSel } }))
  }
  const curObs = obsIdx >= 0 ? OBS[obsIdx] : null
  const toggle = (k: keyof typeof layers) => setLayers(s => ({ ...s, [k]: !s[k] }))

  return (
    <div className="app">
      <DeckGL viewState={view} onViewStateChange={(e: any) => { setView(e.viewState); if (e.interactionState?.isDragging) setFollow(false) }} controller={true} layers={L}
        getCursor={({ isHovering }) => (isHovering ? 'pointer' : 'grab')}
        getTooltip={({ object, layer }: any) => !object ? null : layer?.id === 'roads' ? { text: `${object.name || object.ref || 'Road'}${object.cut ? ' · crosses water seen on 29 Sep' : ''}` } : layer?.id === 'shelters' ? { text: `${object.name || 'Unnamed'} · ${object.amenity}` } : layer?.id === 'villages' ? { text: `${object.name} · ${STATE_LABEL[states.get(object.id)!]}` } : null} />

      {phase === 'landing' && (
        <div className="landing" ref={landingRef}>
          <Spotlight className="landing-spotlight" fill="#38bdf8" />
          <div className="landing-shell">
            <div className="landing-kicker eyebrow">JalNetra <span>·</span> flood intelligence for the Gandak corridor</div>
            <div className="landing-grid">
              <section className="landing-copy">
                <div className="landing-reveal landing-label">A clear signal, before the water arrives</div>
                <h1 className="landing-reveal">See the flood move from Nepal to the village.</h1>
                <p className="landing-reveal">Replay the September 2026 Gandak event as one connected story: rain upstream, river flow downstream, radar proof, and a warning a village can act on.</p>
                <div className="lbtns landing-reveal">
                  <button className="primary" onClick={startStory}>Start the story <FiArrowRight /></button>
                  <button onClick={explore}><FiMap /> Explore the map</button>
                </div>
                <div className="operator-guard landing-reveal">
                  <div><span className="guard-dot" /> Operator approval stays human</div>
                  <p>Review the signal and wording before anything is sent.</p>
                  <button onClick={openOps}>Open operator dashboard <FiArrowRight /></button>
                </div>
                <div className="landing-actions" aria-label="JalNetra tools">
                  <button className="action-tile" onClick={explore}><FiMap /><span><b>Technical map</b><small>Explore the evidence</small></span><FiArrowRight /></button>
                  <button className="action-tile" onClick={openOps}><FiList /><span><b>Operator dashboard</b><small>Review incidents</small></span><FiArrowRight /></button>
                  <button className="action-tile" onClick={onValidate}><FiCheckCircle /><span><b>Validation</b><small>See model performance</small></span><FiArrowRight /></button>
                </div>
              </section>
              <aside className="landing-signal landing-reveal" aria-label="JalNetra signal path">
                <div className="signal-head"><span>One connected view</span><span className="signal-status"><i /> historical replay</span></div>
                <div className="signal-map" aria-hidden="true"><div className="signal-grid" /><div className="signal-route" /><div className="signal-beacon beacon-nepal" /><div className="signal-beacon beacon-village" /><div className="landing-flow-bead" /></div>
                <div className="landing-flow">
                  <div><b>01</b><strong>Nepal</strong><span>rain signal</span></div><i /><div><b>02</b><strong>River</strong><span>flow response</span></div><i /><div><b>03</b><strong>Village</strong><span>human review</span></div>
                </div>
                <p className="signal-note">The map keeps the evidence in view while the signal travels downstream.</p>
              </aside>
            </div>
            <BentoGrid className="landing-proof landing-reveal">
              <BentoGridItem title={`${D.villages.length} villages`} description="tracked along the corridor" />
              <BentoGridItem title={`${st.length} river points`} description="daily GloFAS flow observations" />
              <BentoGridItem title={`${O2.km2.toLocaleString()} km²`} description="new water in the radar pass" />
              <BentoGridItem title="Sentinel-1 + 2" description="satellite evidence, with sources" />
            </BentoGrid>
            <div className="lsrc landing-reveal">Sources: ESA Copernicus Sentinel-1/2 · GloFAS via Open-Meteo · Copernicus DEM · OpenStreetMap · GeoNames</div>
          </div>
        </div>
      )}
      {phase === 'story' && (
        <aside className="story">
          <div className="sprog">{STEPS.map((_, k) => <button key={k} aria-label={`Go to step ${k + 1}`} className={k <= step ? 'on' : ''} onClick={() => applyStep(k)} />)}</div>
          <div className="kicker">{STEPS[step].kicker}</div>
          <h2>{STEPS[step].title}</h2>
          <p className="sbody">{STEPS[step].body}</p>
          {STEPS[step].facts && STEPS[step].facts!.length > 0 && <dl className="kv sfacts">{STEPS[step].facts!.map(([k, v]) => <div key={k} className="frow"><dt>{k}</dt><dd>{v}</dd></div>)}</dl>}
          {STEPS[step].chart !== undefined && <Spark q={st[STEPS[step].chart!].q} t={t} peakDay={st[STEPS[step].chart!].peakDay} />}
          {STEPS[step].legend && <Legend />}
          {STEPS[step].today && <TodayCard bare live={live} />}
          {sel && STEPS[step].select && <VillageCard v={sel} state={states.get(sel.id)!} obs={curObs} onClose={() => setSel(null)} bare />}
          <div className="sdate">{fmtDay(t)}{playing ? ' · playing' : ''}</div>
          <div className="snav">
            <button onClick={() => (step === 0 ? onHome() : applyStep(step - 1))}><FiArrowLeft /> Back</button>
            {step < STEPS.length - 1 ? <button className="primary" onClick={() => applyStep(step + 1)}>Next <FiArrowRight /></button> : <button className="primary" onClick={explore}><FiMap /> Explore the map</button>}
          </div>
          {step === STEPS.length - 1 && <><button className="link" onClick={onValidate}>What if JalNetra had been running live?</button><button className="link" onClick={onLive}>Go to live prediction</button><button className="link" onClick={() => applyStep(0)}>Replay the story</button></>}
        </aside>
      )}
      {phase === 'ops' && (<>
        <header className="top map-top"><AppBrand onClick={onHome} /><div className="brand"><div className="eyebrow">Incident log</div><div className="title">Incidents from every JalNetra part</div></div><span className="map-spacer" /><button className="storybtn" onClick={onLive}>Live prediction</button></header>
        <OpsPanel inc={inc} selId={opsSel} onSelect={selectInc} onViewFloodSpread={setFloodSpreadHorizon} onBack={() => { setFloodSpreadHorizon(null); onLive() }} />
      </>)}
      {phase === 'explore' && (<>
      <header className="top map-top">
        <AppBrand onClick={onHome} />
        <div className="brand">
          <div className="eyebrow">Gandak corridor, Nepal to Bihar</div>
          <div className="title">September 2026 flood · historical replay</div>
        </div>
        <div className="seg" aria-label="What to show">
          <button className={mode === 'early' ? 'on' : ''} title="Forecast view: river flow and rain in the days before the flood" onClick={() => setMode('early')}>Early warning</button>
          <button className={mode === 'active' ? 'on' : ''} title="Satellite view: water that radar actually saw" onClick={() => { setMode('active'); if (obsIdx < 0) setT(OBS[1].day + 0.01) }}>Active flood</button>
        </div>
        <span className="map-spacer" />
        <button className="storybtn" onClick={onStory}><FiRotateCcw /> Glacier story</button>
        <button className="storybtn" onClick={onValidate}>Validation</button>
        <button className="storybtn" onClick={onLive}>Live prediction</button>
        <button className="storybtn" onClick={openOps}>Incident log</button>
        <div className="seg" aria-label="Basemap">
          <button className={sat ? 'on' : ''} onClick={() => setSat(true)}>Satellite</button>
          <button className={!sat ? 'on' : ''} onClick={() => setSat(false)}>Map</button>
        </div>
      </header>
      {intro && <section className="map-intro" aria-label="How to read this map">
        <h2>What you are looking at</h2>
        <p>The September 2026 Gandak flood, replayed from satellite and river data. Press play on the timeline to watch the water travel from Nepal into Bihar.</p>
        <ul>
          <li><i style={{ background: 'rgba(29,111,184,.8)' }} /> Blue: water seen by Sentinel-1 radar (Active flood)</li>
          <li><i style={{ background: 'rgba(245,158,11,.7)' }} /> Orange: corridor where villages are at risk</li>
          <li><i style={{ background: 'rgb(56,189,248)', borderRadius: 999 }} /> Dots: villages, coloured by status</li>
        </ul>
        <button onClick={() => setIntro(false)}>Got it</button>
      </section>}
      <div className="map-attr">{sat ? 'Imagery © Esri, Maxar, Earthstar' : '© OpenStreetMap contributors, © CARTO'}</div>

      <div className="toggles">
        {([['observed', 'Observed flood'], ['route', 'Expected pathway'], ['corridor', 'Risk corridor'], ['villages', 'Villages'], ['roads', 'Roads'], ['shelters', 'Schools, hospitals']] as const).map(([k, l]) => (
          <label key={k} className="tg"><input id={'tg-' + k} type="checkbox" checked={layers[k]} onChange={() => toggle(k)} /><span>{l}</span></label>
        ))}
      </div>

      <aside className="panel">
        {sel ? <VillageCard v={sel} state={states.get(sel.id)!} obs={mode === 'today' ? OBS[LATEST] : mode === 'active' ? curObs : null} onClose={() => setSel(null)} /> : reach ? <ReachCard r={reach} t={t} onClose={() => setReach(null)} /> : (
          <>
            {mode === 'today' ? <TodayCard live={live} /> : mode === 'active' && curObs ? (
              <section>
                <div className="kicker live">Flood event detected</div>
                <div className="h">{curObs.place}</div>
                <dl className="kv">
                  <dt>Observed</dt><dd>{fmtTime(curObs.time)}</dd>
                  <dt>New water</dt><dd>{curObs.km2.toLocaleString()} km², compared with {shortDate(curObs.base)}</dd>
                  <dt>Radar coverage</dt><dd>{Math.round(curObs.coverage * 100)}% of the map</dd>
                </dl>
                <div className="kicker mt">Downstream analysis</div>
                <p className="note">{analyzing ? 'Analyzing connected downstream regions…' : `${counts.affected} villages have observed water within 500 m. ${counts.atrisk} more sit inside the risk corridor.`}</p>
              </section>
            ) : (
              <section>
                <div className="kicker">Early warning</div>
                <div className="h">Rain in Nepal, flow in the Gandak</div>
                <dl className="kv">
                  <dt>Day</dt><dd>{fmtDay(t)}</dd>
                  <dt>Nepal rain</dt><dd>{Math.round(Math.max(...rainAt(t)))} mm, highest of 4 points</dd>
                  <dt>{st[0].label}</dt><dd>{Math.round(interpQ(st[0].q, t)).toLocaleString()} m³/s</dd>
                  <dt>{st[st.length - 1].label}</dt><dd>{Math.round(interpQ(st[st.length - 1].q, t)).toLocaleString()} m³/s</dd>
                </dl>
                <p className="note">{counts.atrisk} villages sit inside the risk corridor and {counts.watch} within 2 km of it.</p>
              </section>
            )}
            <section>
              <div className="kicker">Flood analysis</div>
              <dl className="kv small">
                <dt>Observed</dt><dd>Sentinel-1 radar, {OBS.map(o => shortDate(o.time)).join(', ')}</dd>
                <dt>Rainfall</dt><dd>Open-Meteo daily, 4 points in Nepal</dd>
                <dt>River</dt><dd>GloFAS daily discharge, {st.length} points</dd>
                <dt>Terrain</dt><dd>Copernicus DEM, 30 m</dd>
                <dt>Imagery</dt><dd>Sentinel-2, {D.s2range}</dd>
                <dt>Rivers, roads</dt><dd>OpenStreetMap, fetched {D.osmFetched}</dd>
                <dt>Villages</dt><dd>GeoNames, {D.villages.length} places</dd>
              </dl>
              <p className="note">Risk corridor (predicted): {D.corridor.rule}. {D.corridor.check}</p>
            </section>
            <Legend />
          </>
        )}
      </aside>

      {follow && t >= DAYS - 1.01 && <div className="endcard">From upstream signal to downstream village.</div>}
      <footer className="timeline">
        <div className="controls">
          <button aria-label="Previous day" onClick={() => { setPlaying(false); setT(x => Math.max(0, Math.ceil(x) - 1)) }}><FiSkipBack /></button>
          <button aria-label={playing ? 'Pause' : 'Play'} className="play" onClick={() => { if (t >= DAYS - 1) setT(0); setPlaying(p => !p) }}>{playing ? <FiPause /> : <FiPlay />}</button>
          <button aria-label="Next day" onClick={() => { setPlaying(false); setT(x => Math.min(DAYS - 1, Math.floor(x) + 1)) }}><FiSkipForward /></button>
          <button className={'follow' + (follow ? ' on' : '')} onClick={() => (follow ? resetView() : startFollow())}><FiNavigation /> {follow ? 'Stop following' : 'Follow the water'}</button>
        </div>
        <div className="track">
          <div className="date">{fmtDay(t)}</div>
          <div className="bar">
            <div className="ticks">{Array.from({ length: DAYS }, (_, i) => { const dd = new Date(START + i * 864e5); return <span key={i} style={{ left: `${(i / (DAYS - 1)) * 100}%` }}>{i === 0 || dd.getUTCDate() === 1 || dd.getUTCDate() % 5 === 0 ? dd.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }) : ''}</span> })}</div>
            <input type="range" min={0} max={DAYS - 1} step={0.01} value={t} onChange={e => { setPlaying(false); setT(+e.target.value) }} aria-label="Timeline" />
            {OBS.map(o => <button key={o.id} className="obs" style={{ left: `${(o.day / (DAYS - 1)) * 100}%` }} onClick={() => { setPlaying(false); setMode('active'); setT(o.day + 0.01) }} aria-label={`Sentinel-1 pass ${fmtTime(o.time)}`} title={`Sentinel-1 · ${fmtTime(o.time)}`} />)}
          </div>
        </div>
      </footer>
      </>)}
    </div>
  )
}

function ReachCard({ r, t, onClose }: { r: { km: number; si: number }; t: number; onClose: () => void }) {
  const s = st[r.si]
  return (
    <section>
      <div className="vhead"><div><div className="kicker">River segment · {Math.round(r.km)} km below Devghat</div><div className="h">Gandak near {s.label}</div></div><button className="x" onClick={onClose} aria-label="Close"><FiX /></button></div>
      <dl className="kv">
        <dt>Flow on {fmtDay(t).slice(0, 6)}</dt><dd>{Math.round(interpQ(s.q, t)).toLocaleString()} m³/s</dd>
        <dt>Event peak</dt><dd>{Math.round(s.peakQ).toLocaleString()} m³/s on {fmtDay(s.peakDay)}</dd>
        <dt>Source</dt><dd>GloFAS daily discharge via Open-Meteo</dd>
      </dl>
      <Spark q={s.q} t={t} peakDay={s.peakDay} />
      <p className="note">GloFAS is a global model and reads lower than local gauges. The official Valmikinagar reading on 28 Sep was 5.43 lakh cusecs, about 15,400 m³/s.</p>
    </section>
  )
}

function Spark({ q, t, peakDay }: { q: number[]; t: number; peakDay: number }) {
  const w = 300, h = 70, mx = Math.max(...q), mn = Math.min(...q)
  const X = (i: number) => 4 + (i / (q.length - 1)) * (w - 8), Y = (v: number) => 6 + (1 - (v - mn) / (mx - mn)) * (h - 18)
  const d = q.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="spark" role="img" aria-label="Daily discharge">
      <path d={d + `L${X(q.length - 1)},${h - 12}L${X(0)},${h - 12}Z`} fill="rgba(56,189,248,.14)" />
      <path d={d} fill="none" stroke="#7dd3fc" strokeWidth="1.6" />
      <line x1={X(t)} x2={X(t)} y1="4" y2={h - 12} stroke="#e6edf3" strokeOpacity=".7" />
      <circle cx={X(peakDay)} cy={Y(q[peakDay])} r="3" fill="#e6edf3" />
      <text x="4" y={h - 1} fontSize="9" fill="#66727f">{fmtDay(0).slice(0, 6)}</text>
      <text x={w - 4} y={h - 1} fontSize="9" fill="#66727f" textAnchor="end">{fmtDay(q.length - 1).slice(0, 6)}</text>
    </svg>
  )
}

function TodayCard({ bare, live }: { bare?: boolean; live?: typeof LIVE }) {
  const LV = live ?? LIVE
  const ist = new Date(LV.fetched).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
  const h = LV.stations[LV.stations.length - 1], dv = LV.stations[0]
  const lvl = { none: ['No flood warning', 'safe'], watch: ['Watch', 'watch'], warning: ['Flood warning', 'atrisk'] }[LV.level]
  const o = OBS[LATEST]
  return (
    <section className={bare ? 'bare' : ''}>
      {!bare && <div className="kicker live">Live check</div>}
      <div className={'pill ' + lvl[1]}>{lvl[0]}</div>
      <dl className="kv">
        <dt>Checked</dt><dd>{ist} IST</dd>
        <dt>{h.label} today</dt><dd>{Math.round(h.q[h.today]).toLocaleString()} m³/s</dd>
        <dt>{dv.label} today</dt><dd>{Math.round(dv.q[dv.today]).toLocaleString()} m³/s</dd>
        <dt>Latest radar</dt><dd>{fmtTime(o.time)}, {o.km2} km² still under water</dd>
        <dt>Next radar</dt><dd>Expected {LV.nextPasses.map(d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })).join(', ')}</dd>
      </dl>
      <ForecastSpark s={h} />
      <ul className="reasons">{LV.reasons.map(r => <li key={r}>{r}</li>)}</ul>
      <p className="note">Warning rule (JalNetra): forecast flow reaching 80% of the late-September peak at any point. Forecast: GloFAS via Open-Meteo, ensemble range shaded.</p>
    </section>
  )
}

function ForecastSpark({ s }: { s: (typeof LIVE)['stations'][number] }) {
  const w = 300, h = 80, all = [...s.qmax, ...s.qmin, s.eventPeak * 0.8], mx = Math.max(...all) * 1.05, mn = Math.min(...all) * 0.95
  const X = (i: number) => 4 + (i / (s.q.length - 1)) * (w - 8), Y = (v: number) => 6 + (1 - (v - mn) / (mx - mn)) * (h - 20)
  const line = (a: number[]) => a.map((v, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('')
  const band = line(s.qmax) + s.qmin.map((v, i) => [i, v] as const).reverse().map(([i, v]) => `L${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('') + 'Z'
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="spark" role="img" aria-label={`River flow forecast at ${s.label}`}>
      <line x1="4" x2={w - 4} y1={Y(s.eventPeak * 0.8)} y2={Y(s.eventPeak * 0.8)} stroke="#f59e0b" strokeDasharray="3 3" strokeOpacity=".8" />
      <text x={w - 4} y={Y(s.eventPeak * 0.8) - 3} fontSize="9" fill="#fbbf24" textAnchor="end">warning level</text>
      <path d={band} fill="rgba(56,189,248,.18)" />
      <path d={line(s.q.slice(0, s.today + 1))} fill="none" stroke="#e6edf3" strokeWidth="1.6" />
      <path d={s.q.map((v, i) => (i < s.today ? '' : `${i === s.today ? 'M' : 'L'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`)).join('')} fill="none" stroke="#7dd3fc" strokeWidth="1.6" strokeDasharray="4 3" />
      <line x1={X(s.today)} x2={X(s.today)} y1="4" y2={h - 14} stroke="#e6edf3" strokeOpacity=".5" />
      <text x={X(s.today) + 3} y="12" fontSize="9" fill="#9aa7b4">today</text>
      <text x="4" y={h - 2} fontSize="9" fill="#66727f">{new Date(s.time[0]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</text>
      <text x={w - 4} y={h - 2} fontSize="9" fill="#66727f" textAnchor="end">{new Date(s.time[s.time.length - 1]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · {s.label}</text>
    </svg>
  )
}

function Legend() {
  return (
    <section className="legend">
      <div className="kicker">Key</div>
      <div className="row"><i className="sw obs" />Observed new water, Sentinel-1</div>
      <div className="row"><i className="sw corr" />Risk corridor, predicted</div>
      <div className="row"><i className="sw flow" />Expected downstream pathway</div>
      <div className="row dots">{(['affected', 'atrisk', 'watch', 'safe'] as State[]).map(s => <span key={s}><i style={{ background: `rgb(${STATE_RGB[s].join(',')})` }} />{STATE_LABEL[s]}</span>)}</div>
    </section>
  )
}

function VillageCard({ v, state, obs, onClose, bare }: { v: V; state: State; obs: (typeof OBS)[number] | null; onClose: () => void; bare?: boolean }) {
  const d = obs ? (v.obs as Record<string, number | null>)[obs.id] : undefined
  const s = st[v.si]
  const reasons: string[] = []
  if (obs && d !== null && d !== undefined) reasons.push(d <= 0.5 ? `Radar saw new water at the village on ${shortDate(obs.time)}` : `Nearest new water on ${shortDate(obs.time)} is ${d.toFixed(1)} km away`)
  if (v.inCorr) reasons.push(`Inside the risk corridor, ${v.h.toFixed(1)} m above the river channel`)
  else if (v.corrDist <= 2) reasons.push(`${v.corrDist.toFixed(1)} km outside the risk corridor`)
  else reasons.push(`${v.h.toFixed(1)} m above the river channel, outside the corridor`)
  reasons.push(`${v.dRiver.toFixed(1)} km from the Gandak main channel`)
  reasons.push(`Flow near ${s.label} peaked on ${fmtDay(s.peakDay)} (GloFAS, daily)`)
  const sh = (v as any).shelter as { name: string; amenity: string; km: number } | undefined
  const HM = ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर']
  const pd = new Date(START + s.peakDay * 864e5)
  const hindi = `नमस्ते। ${v.name} के लोगों के लिए जलनेत्र की बाढ़ चेतावनी। गंडक नदी का पानी बढ़ रहा है। आपके पास नदी का बहाव ${pd.getUTCDate()} ${HM[pd.getUTCMonth()]} को सबसे ऊँचा रहा। कृपया बच्चों, बुज़ुर्गों और गर्भवती महिलाओं को पहले ऊँची सुरक्षित जगह ले जाएँ।`
  const speak = () => { try { const u = new SpeechSynthesisUtterance(hindi); u.lang = 'hi-IN'; speechSynthesis.cancel(); speechSynthesis.speak(u) } catch { /* speech not available */ } }
  return (
    <section className={bare ? 'bare' : ''}>
      {!bare && <div className="vhead"><div><div className="kicker">{v.district ? `${v.district} district` : 'District not listed'}</div><div className="h">{v.name}</div></div><button className="x" onClick={onClose} aria-label="Close"><FiX /></button></div>}
      <div className={'pill ' + state}>{STATE_LABEL[state]}</div>
      <dl className="kv">
        <dt>Observed water</dt><dd>{!obs ? 'Switch to Active flood' : d === null || d === undefined ? 'No radar coverage here' : d <= 0.5 ? 'At the village' : `${d.toFixed(1)} km away`}</dd>
        <dt>Arrival time</dt><dd>Arrival time unavailable</dd>
        <dt>Data time</dt><dd>{obs ? `Sentinel-1 ${fmtTime(obs.time)}` : `GloFAS daily, ${fmtDay(s.peakDay)}`}</dd>
        <dt>Safe place</dt><dd>{sh ? `${sh.name} (${sh.amenity}), ${sh.km} km straight line` : 'None mapped within 12 km outside the risk zone'}</dd>
      </dl>
      {sh && <p className="note">Nearest school, college or hospital outside the risk corridor with no flood water seen (OpenStreetMap). Not a confirmed relief shelter.</p>}
      <div className="kicker mt">Why this status</div>
      <ul className="reasons">{reasons.map(r => <li key={r}>{r}</li>)}</ul>
      <div className="kicker mt">Hindi warning</div>
      <p className="hi">{hindi}</p>
      <button className="speak" onClick={speak}><FiVolume2 /> Play in browser</button>
    </section>
  )
}
