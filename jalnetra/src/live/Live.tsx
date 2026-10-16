import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import DeckGL from '@deck.gl/react'
import { FlyToInterpolator, WebMercatorViewport, type MapViewState, type PickingInfo } from '@deck.gl/core'
import { BitmapLayer, GeoJsonLayer, IconLayer, PathLayer, PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers'
import { PathStyleExtension } from '@deck.gl/extensions'
import { TileLayer } from '@deck.gl/geo-layers'
import gsap from 'gsap'
import { FiMoreHorizontal, FiPause, FiPlay, FiRefreshCw, FiSkipForward, FiLayers, FiCheckCircle, FiX, FiChevronDown, FiChevronRight, FiChevronLeft, FiPhoneCall, FiExternalLink, FiAlertTriangle, FiRotateCcw, FiSend, FiCamera, FiCopy } from 'react-icons/fi'
import D from '../data.json'
import s2 from '../img/s2.jpg'
import o1 from '../img/o1.png'
import o2 from '../img/o2.png'
import o3 from '../img/o3.png'
import { countryBorders as countries } from '../countryBorders'
import { HORIZONS, eventInputs, runModel, type Level, type ModelRun, type VillageRisk } from '../engine/core'
import { liveInputs } from '../engine/sources'
import { bounds, extentAt, loadTerrain, type Extent, type Terrain } from '../engine/terrain'
import { buildGraph, evacuate, impactStats, type Route } from '../engine/route'
import { approveIncident, createIncident, hasKey, listRuns, type RunSummary, listAlerts, listContacts, saveKey, sendAlerts, setStatus, type Alert, type Contact, type Incident } from '../ops'
import { FONT, HLABEL, LEVEL_RGB, M, VBY, VILLAGES, citizenAlert, fmtIST, fmtQ, englishAlert, hindiAlert, impactText, windowText } from './shared'
import { VILLAGES as EXERCISE_IDS, DemoApiError, approveAlert, createSession, getEscalation, getSession, type EscalationView } from '../demo/api'
import { approvalKey, readAttempt, writeAttempt } from '../demo/workflowState'
import type { DemoAlert, DemoSession, Horizon } from '../demo/types'
import { AppBrand } from '../components/AppBrand'
import { useIndiaRivers } from './useIndiaRivers'
import { IndiaDetail } from './IndiaDetail'
import { ListenButton, PhotoCheck, WalkSteps } from './AwsTools'
import { MAPBOX_TOKEN, MapboxLive, googleWalk, useRealRoute } from './MapboxRoute'
import { floodTile, useSentinel } from './sentinel'
import { draftAdvisory, hindiRouteLine, walkingRoute, type Draft, type Walk } from './aws'
import { encodeRoute, mapsLink, publicBase, shareText, shortRouteLink, simplify, type SharedRoute } from './routeShare'
import type { PointStatus, RiverPoint, Status } from '../engine/india'
import { SPREAD_CLOCK, REACH_HALF_KM, buildTownSpread, townFacts, townImage, type TownFacts } from '../floodSpread/townSpread'
import { EVAC_BUFFER_CELLS, placePhones, townZone } from '../floodSpread/zone'
import { FALLBACK_DENSITY_PER_KM2, PHONES_PER_PERSON, zonePopulation } from '../floodSpread/population'

type Mode = 'live' | 'demo'
type AlertState = { stage: 'review' | 'approving' | 'calling' | 'contacted' | 'evacuating' | 'resolved' | 'dismissed' | 'error'; incident?: Incident; approved?: boolean; error?: string; telephony?: string; esc?: { sessionId: string; alertId: string } }
const OBS_IMG: Record<string, string> = { o1, o2, o3 }
const DEMO_START = Date.parse('2026-09-25T06:00:00Z'), DEMO_END = Date.parse('2026-10-01T00:00:00Z'), STEP_H = 3
const LIVE_EVERY = 15 * 60e3, RETRY_EVERY = 2 * 60e3
// The live map opens on all of India; selecting a river point or an alert flies in to it.
const INITIAL: MapViewState = { longitude: 82.5, latitude: 22.8, zoom: 4.4, pitch: 0, bearing: 0, minZoom: 3.5, maxZoom: 14 }
const INDIA_RGB: Record<Status, [number, number, number]> = { NORMAL: [110, 124, 116], RISING: [43, 108, 176], WARNING: [217, 138, 24], DANGER: [196, 48, 43] }
const INDIA_WORD: Record<Status, string> = { NORMAL: 'Normal', RISING: 'Rising fast', WARNING: 'High', DANGER: 'Above 2025 peak' }
const STAGES = ['Live data', 'Trend analysis', 'Water-level forecast', 'Flood extent', 'Village impact', 'Evacuation routes', 'Risk score', 'Operator approval', 'AI voice alert', 'Incident tracking']
const ROUTE_EXTENSIONS = [new PathStyleExtension({ dash: true })]
// Phone icons for the evacuation zone: a handset with a red alert screen, and the same handset with a green tick once notified.
const phoneSvg = (screen: string, glyph: string) => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="64" viewBox="0 0 40 64"><rect x="3" y="2" width="34" height="60" rx="7" fill="#111827" stroke="#fff" stroke-width="2.5"/><rect x="7" y="9" width="26" height="42" rx="3" fill="${screen}"/><rect x="15" y="4.5" width="10" height="2" rx="1" fill="#6b7280"/><circle cx="20" cy="56.5" r="2.4" fill="#6b7280"/>${glyph}</svg>`)
const PHONE_ALERT = { url: phoneSvg('#ef4444', '<path d="M20 16v17" stroke="#fff" stroke-width="4.5" stroke-linecap="round"/><circle cx="20" cy="42" r="2.8" fill="#fff"/>'), width: 40, height: 64, anchorY: 32 }
const PHONE_OK = { url: phoneSvg('#22c55e', '<path d="M12 31l6 6 11-14" stroke="#fff" stroke-width="4.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'), width: 40, height: 64, anchorY: 32 }
// Map labels: dark text on a light plate so they read on satellite imagery.
const LABEL = { background: true, getBackgroundColor: [252, 253, 250, 236] as [number, number, number, number], backgroundPadding: [5, 2] as [number, number], getColor: [13, 25, 18, 255] as [number, number, number, number], fontFamily: FONT, fontWeight: 650, characterSet: 'auto' as const, fontSettings: { sdf: true } }
const latinOr = (name: string, fallback: string) => (/^[\x20-\x7E\u00C0-\u024F]+$/.test(name) ? name : fallback)
// Exercise approvals go through the /demo backend, so its server-side limits apply (one attempt per alert, 30 s cooldown,
// 3 calls per session) and the call can only reach the configured demo phone. The session is created once and reused.
let exerciseSession: Promise<DemoSession> | null = null
function ensureExerciseSession(): Promise<DemoSession> {
  if (exerciseSession) return exerciseSession
  const p = (async () => {
    const existing = readAttempt('create')
    if (existing?.state === 'settled' && existing.sessionId) {
      try { return await getSession(existing.sessionId) } catch (e) { if (!(e instanceof DemoApiError) || (e.status !== 404 && e.status !== 403)) throw e }
    }
    if (existing && (existing.state === 'inflight' || existing.state === 'unknown')) throw new Error('An earlier session creation was not confirmed. It will not be repeated automatically; nothing was sent.')
    const requestId = crypto.randomUUID()
    writeAttempt('create', { requestId, state: 'inflight' })
    try {
      const created = await createSession(requestId)
      writeAttempt('create', { requestId, state: 'settled', sessionId: created.id })
      return created
    } catch (e) {
      try { writeAttempt('create', { requestId, state: e instanceof DemoApiError && e.ambiguous ? 'unknown' : 'rejected' }) } catch { /* storage unavailable */ }
      throw e
    }
  })()
  exerciseSession = p
  p.catch(() => { if (exerciseSession === p) exerciseSession = null })
  return p
}
const HORIZON_SET = [0, 3, 6, 12, 24]
function exerciseOutcome(a: DemoAlert, masked: string | null): Partial<AlertState> {
  const where = masked ? `demo phone ${masked}` : 'the demo phone'
  if (a.callStatus === 'dispatched') return { stage: 'contacted', approved: true, telephony: `Dispatched to ${where}. This does not confirm anyone answered.`, error: undefined }
  if (a.callStatus === 'failed') return { stage: 'error', approved: true, error: 'The call failed. It will not be retried automatically.' }
  if (a.callStatus === 'not_configured') return { stage: 'error', approved: true, error: 'No call was placed: the demo phone or provider is not configured on the server.' }
  return { stage: 'error', approved: true, error: 'The call outcome is not confirmed. Do not repeat it; check the provider dashboard.' }
}

// The five exercise towns are real villages of the Gandak model. Their risk, probability, score, factors and impact time come from the
// model run behind the map (the replayed September 2026 flood, or the live forecast): nothing about them is scripted.
const incidentApproved = (incident: Incident) => ['approved', 'contacted', 'evacuating', 'resolved', 'verified'].includes(incident.status)

function toCanvas(img: ImageData | null) {
  if (!img) return null
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
  c.getContext('2d')!.putImageData(img, 0, 0); return c
}

export default function Live({ mode, onHome, onValidate, onOpenIncident }: { mode: Mode; onHome: () => void; onValidate: () => void; onOpenIncident: (id: string) => void }) {
  const [view, setView] = useState<MapViewState>(INITIAL)
  const [terrain, setTerrain] = useState<Terrain | null>(null)
  const [run, setRun] = useState<ModelRun | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [nextAt, setNextAt] = useState<number>(Date.now())
  const [sim, setSim] = useState(DEMO_START)
  const [paused, setPaused] = useState(false)
  const [period, setPeriod] = useState(30)
  const [h, setH] = useState<number>(6)
  const [sel, setSel] = useState<number | null>(null)
  const [alerts, setAlerts] = useState<Record<number, AlertState>>({})
  const [events, setEvents] = useState<{ t: number; text: string; kind: 'info' | 'warn' | 'crit' | 'ok' }[]>([])
  const india = useIndiaRivers()
  const sentinel = useSentinel(mode === 'live')   // newest Sentinel-1 / Sentinel-2 scenes from the Planetary Computer catalogue
  const [indiaSel, setIndiaSel] = useState<number | null>(null)
  const [layers, setLayers] = useState({ india: true, sat: false, predicted: true, observed: true, villages: true, roads: false, shelters: false, route: true, rain: false, rivers: true })
  const [showLayers, setShowLayers] = useState(false)
  const [menu, setMenu] = useState(false)
  const [mapView, setMapView] = useState<'current' | '2d' | '3d'>('current')
  const [photo, setPhoto] = useState(false)
  const [detail, setDetail] = useState(false)
  const [showLeftPanel, setShowLeftPanel] = useState(false)
  const [showRightPanel, setShowRightPanel] = useState(false)
  const [running, setRunning] = useState(false)
  const [replayNote, setReplayNote] = useState<string | null>(null)
  const [replayHidden, setReplayHidden] = useState(false)
  const [broadcast, setBroadcast] = useState<{ key: string; p: number } | null>(null)
  const [spreadSource, setSpreadSource] = useState<'replay' | 'live'>('replay')
  const [showFlood, setShowFlood] = useState(true)
  const [showEvac, setShowEvac] = useState(true)
  const [showPhones, setShowPhones] = useState(true)
  const [pop, setPop] = useState<{ key: string; total: number | null; loading: boolean; source: 'worldpop' | 'estimate'; error?: string } | null>(null)
  const prev = useRef<ModelRun | null>(null)
  const pipeRef = useRef<HTMLDivElement>(null)
  const topRef = useRef<HTMLDivElement>(null)
  const [topH, setTopH] = useState(130)
  useEffect(() => { if (!topRef.current) return; const ro = new ResizeObserver(e => setTopH(Math.round(e[0].contentRect.height))); ro.observe(topRef.current); return () => ro.disconnect() }, [])

  useEffect(() => { loadTerrain(M).then(setTerrain).catch(e => setErr('Terrain grid failed to load: ' + e)) }, [])
  // ---- the monitoring loop: fetch inputs, run the model, diff against the previous run
  const doRun = async (simNow?: number) => {
    setRunning(true)
    let failedLive = false
    try {
      const inp = mode === 'live' ? await liveInputs(M) : eventInputs(M, simNow ?? sim)
      const r = runModel(M, inp)
      setRun(r); setErr(null); setReplayNote(null)
      diff(prev.current, r); prev.current = r
    } catch (e) {
      const why = (e as Error).message
      if (mode === 'live') {
        failedLive = true
        // Live river data is rate limited or down: keep the page usable on the bundled September 2026 replay, clearly labelled,
        // so the exercise alerts and flood spread still work. It is never presented as live data.
        const r = runModel(M, eventInputs(M, Date.parse(SPREAD_CLOCK), 'replay'))
        setRun(r); setErr(null); setReplayNote(why); prev.current = r
      } else setErr(`Live sources unreachable (${why}). No prediction shown rather than a guess. Try the demo simulation.`)
    }
    finally { setRunning(false); setNextAt(Date.now() + (mode === 'live' ? (failedLive ? RETRY_EVERY : LIVE_EVERY) : period * 1000)) }
  }
  const diff = (a: ModelRun | null, b: ModelRun) => {
    const t = b.now, out: typeof events = []
    if (!a) out.push({ t, text: `Model run: ${b.inputs.observations} observations in, ${b.atRisk} villages at risk`, kind: 'info' })
    else {
      if (a.river !== b.river) out.push({ t, text: `River ${b.river.toLowerCase()}`, kind: b.river.startsWith('Rising') ? 'warn' : 'info' })
      if (a.rainLevel !== b.rainLevel) out.push({ t, text: `Rain level ${b.rainLevel.toLowerCase()}`, kind: b.rainLevel === 'HIGH' ? 'warn' : 'info' })
      if (a.atRisk !== b.atRisk) out.push({ t, text: `Villages at risk ${a.atRisk} → ${b.atRisk}`, kind: b.atRisk > a.atRisk ? 'warn' : 'ok' })
      const was = new Map(a.villages.map(v => [v.id, v.level]))
      const crit = b.villages.filter(v => v.level === 'CRITICAL' && was.get(v.id) !== 'CRITICAL')
      if (crit.length) out.push({ t, text: `${crit.slice(0, 3).map(v => VBY.get(v.id)!.name).join(', ')}${crit.length > 3 ? ` +${crit.length - 3}` : ''} became CRITICAL`, kind: 'crit' })
      const nh = b.villages.filter(v => v.level === 'HIGH' && !['HIGH', 'CRITICAL'].includes(was.get(v.id)!))
      if (nh.length) out.push({ t, text: `${nh.length} new HIGH-risk alert${nh.length > 1 ? 's' : ''} waiting for an operator`, kind: 'warn' })
    }
    if (!out.length) out.push({ t, text: 'Model run: no change', kind: 'info' })
    setEvents(e => [...out.reverse(), ...e].slice(0, 30))
  }
  // reset when the mode changes
  useEffect(() => { prev.current = null; setEvents([]); setAlerts({}); setSel(null); setSim(DEMO_START); setLayers(l => ({ ...l, observed: true })); doRun(DEMO_START) }, [mode]) // eslint-disable-line
  // schedule
  useEffect(() => {
    if (mode === 'demo' && paused) return
    const ms = Math.max(0, nextAt - Date.now())
    const id = setTimeout(() => {
      if (mode === 'demo') { const n = Math.min(DEMO_END, sim + STEP_H * 3600e3); setSim(n); if (n >= DEMO_END) setPaused(true); doRun(n) } else doRun()
    }, ms)
    return () => clearTimeout(id)
  }, [nextAt, paused, mode, sim]) // eslint-disable-line
  const runNow = () => { if (mode === 'demo') { const n = Math.min(DEMO_END, sim + STEP_H * 3600e3); setSim(n); doRun(n) } else doRun() }
  const restart = () => { prev.current = null; setEvents([]); setAlerts({}); setSel(null); setSim(DEMO_START); setPaused(false); doRun(DEMO_START) }

  // pipeline animation on each run
  useEffect(() => {
    if (!run || !pipeRef.current) return
    const els = pipeRef.current.querySelectorAll('.stage.model')
    gsap.fromTo(els, { opacity: 0.35 }, { opacity: 1, duration: 0.25, stagger: 0.12, ease: 'power1.out' })
  }, [run])

  // ---- flood extents for each horizon
  const extents = useMemo(() => {
    if (!run || !terrain) return null
    const style = mode === 'demo' ? 'simulated' : 'predicted'
    const out: Record<number, Extent & { canvas: HTMLCanvasElement | null }> = {}
    for (const hz of HORIZONS) { const e = extentAt(M, terrain, run.stations, hz, style); out[hz] = { ...e, canvas: toCanvas(e.image) } }
    return out
  }, [run, terrain, mode])
  const graph = useMemo(() => (terrain ? buildGraph(D.roads as any, terrain) : null), [terrain])
  // routing avoids the union of water now and in 24 h
  const routeMask = useMemo(() => {
    if (!extents) return null
    const a = extents[0].mask, b = extents[24].mask, m = new Uint8Array(a.length), p = new Uint8Array(a.length)
    for (let i = 0; i < a.length; i++) { m[i] = a[i] === 2 || b[i] === 2 ? 2 : a[i] || b[i] ? 1 : 0; p[i] = Math.max(extents[0].prob[i], extents[24].prob[i]) }
    return { m, p }
  }, [extents])
  // Town-level flood spread (normal river vs flooded river) for the exercise villages, replayed from September 2026.
  const replayRun = useMemo(() => runModel(M, eventInputs(M, Date.parse(SPREAD_CLOCK), 'replay')), [])
  const liveOk = mode === 'live' && !!run && !replayNote
  const spreadRun = spreadSource === 'live' && liveOk ? run! : replayRun
  const spreadTowns = useMemo(() => EXERCISE_IDS.flatMap(id => { const v = VBY.get(id); return v ? [{ id, lat: v.lat, lng: v.lng, ch: v.ch }] : [] }), [])
  const spread = useMemo(() => (mode === 'live' && terrain ? buildTownSpread(terrain, spreadTowns, spreadRun) : null), [mode, terrain, spreadTowns, spreadRun])
  const exercise = useMemo(() => (mode === 'live' && spread ? EXERCISE_IDS.flatMap(id => {
    const v = spreadRun.villages.find(x => x.id === id)
    if (!v || !spread) return []
    // the village model's probability and score are kept; the arrival time is the flood front reaching the village in the terrain model
    const h = spread.arrival.get(id)
    if (h === null || h === undefined) return [v]
    return [{ ...v, impactH: h, window: h === 0 ? [0, 0] as [number, number] : [Math.max(0, Math.round(h * 0.8 - 1)), Math.round(h * 1.2 + 2)] as [number, number] }]
  }) : []), [mode, spread, spreadRun])
  const exerciseIds = useMemo(() => new Set(exercise.map(e => e.id)), [exercise])
  const risk = useMemo(() => new Map([...(run?.villages ?? []), ...exercise].map(v => [v.id, v])), [run, exercise])
  const routes = useMemo(() => {
    const out = new Map<number, Route | null>()
    if (!run || !graph || !terrain || !routeMask) return out
    const want = new Set(run.villages.filter(v => v.level === 'HIGH' || v.level === 'CRITICAL').sort((a, b) => b.score - a.score).slice(0, 15).map(v => v.id)); if (sel) want.add(sel)
    for (const e of exercise) want.add(e.id)
    for (const id of want) { const v = VBY.get(id)!; const rm = spread && exerciseIds.has(id) ? spread.routeMask : { m: routeMask.m, p: routeMask.p }; out.set(id, evacuate(graph, terrain, rm.m, rm.p, M.pixel.pstar, v, M.pois)) }
    return out
  }, [run, graph, terrain, routeMask, sel, exercise, spread, exerciseIds])
  const stats = useMemo(() => (extents && graph && terrain ? impactStats(graph, extents[h].mask, D.roads as any, terrain, M.pois) : null), [extents, graph, terrain, h])

  const counts = run?.counts[h] ?? { LOW: 291, MEDIUM: 0, HIGH: 0, CRITICAL: 0 }
  const atRiskH = counts.MEDIUM + counts.HIGH + counts.CRITICAL
  // While live data is unavailable the page runs on the bundled replay: those villages are never offered for approval, only the labelled exercise alerts are.
  const queue = useMemo(() => [...(replayNote ? [] : (run?.villages ?? []).filter(v => !exerciseIds.has(v.id))), ...exercise].filter(v => (exerciseIds.has(v.id) || v.level === 'HIGH' || v.level === 'CRITICAL') && alerts[v.id]?.stage !== 'dismissed').sort((a, b) => (a.level === b.level ? (a.impactH ?? 99) - (b.impactH ?? 99) : a.level === 'CRITICAL' ? -1 : 1)), [run, alerts, exercise, replayNote])
  const selR = sel ? risk.get(sel) ?? null : null
  const anyApproved = Object.values(alerts).some(a => mode === 'demo' ? ['calling', 'contacted', 'evacuating', 'resolved'].includes(a.stage) : a.approved)
  const anyContacted = Object.values(alerts).some(a => ['contacted', 'evacuating', 'resolved'].includes(a.stage))
  const anyIncident = Object.values(alerts).some(a => a.incident)
  const fly = (lng: number, lat: number, zoom = 10.4, pitch = 0, bearing = 0) => setView(v => ({ ...v, longitude: lng, latitude: lat, zoom, pitch, bearing, transitionDuration: 1400, transitionInterpolator: new FlyToInterpolator({ speed: 1.4 }) }))
  // Selecting a village tilts the map so the evacuation route reads in 3D; closing it levels the camera again.
  const pick = (id: number) => { setSel(id); setShowRightPanel(true); const v = VBY.get(id)!; fly(v.lng, v.lat, 11, 55, -18) }
  const closeSel = () => { setSel(null); setView(v => ({ ...v, pitch: 0, bearing: 0, transitionDuration: 900, transitionInterpolator: new FlyToInterpolator({ speed: 1.4 }) })) }

  // ---- map layers
  const L: any[] = []
  const tb = terrain ? bounds(terrain) : null
  // Labels are decluttered in screen space: highest priority first, and a label is dropped if another already holds its spot.
  const vpNow = new WebMercatorViewport({ width: window.innerWidth, height: window.innerHeight, longitude: view.longitude, latitude: view.latitude, zoom: view.zoom ?? 4, pitch: view.pitch ?? 0, bearing: view.bearing ?? 0 })
  const declutter = <T,>(items: T[], pos: (t: T) => [number, number], prio: (t: T) => number, cw = 130, ch = 30): T[] => {
    const used = new Set<string>(), out: T[] = []
    for (const t of [...items].sort((a, b) => prio(b) - prio(a))) {
      const [x, y] = vpNow.project(pos(t))
      if (!(x > -60 && y > -30 && x < window.innerWidth + 60 && y < window.innerHeight + 30)) continue
      const cx = Math.floor(x / cw), cy = Math.floor(y / ch)
      if (used.has(`${cx}:${cy}`) || used.has(`${cx - 1}:${cy}`)) continue
      used.add(`${cx}:${cy}`); out.push(t)
    }
    return out
  }
  L.push(new TileLayer({ id: 'basemap', data: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', minZoom: 0, maxZoom: 17, tileSize: 256,
    renderSubLayers: (p: any) => { const b = p.tile.boundingBox; return new BitmapLayer(p, { data: undefined, image: p.data, bounds: [b[0][0], b[0][1], b[1][0], b[1][1]], desaturate: 0.2, tintColor: [188, 192, 200] }) } }))
  L.push(new GeoJsonLayer({ id: 'countries', data: countries as any, filled: false, stroked: true, getLineColor: [255, 255, 255, 70], lineWidthMinPixels: 1 }))
  if (layers.india && india.data) {
    L.push(new PathLayer({ id: 'india-lines', data: india.data.lines, getPath: (d: any) => d.path, getColor: [125, 200, 255, 170], widthMinPixels: 1.2 }))
    L.push(new ScatterplotLayer({ id: 'india-pts', data: india.data.points, pickable: true, getPosition: (d: RiverPoint) => [d.lng, d.lat], radiusUnits: 'pixels',
      getRadius: (d: RiverPoint) => { const s = india.statuses.get(d.id)?.status ?? 'NORMAL'; return d.id === indiaSel ? 10 : s === 'NORMAL' ? 3 : s === 'RISING' ? 6 : 8 },
      getFillColor: (d: RiverPoint) => [...INDIA_RGB[india.statuses.get(d.id)?.status ?? 'NORMAL'], india.statuses.has(d.id) ? 240 : 90] as any, stroked: true,
      getLineColor: (d: RiverPoint) => (d.id === indiaSel ? [255, 255, 255] : [8, 10, 14]), lineWidthMinPixels: 1,
      onClick: (i: PickingInfo) => { const p = i.object as RiverPoint; setIndiaSel(p.id); setSel(null); setView(v => ({ ...v, longitude: p.lng, latitude: p.lat, zoom: Math.max(v.zoom ?? 0, 8), pitch: 0, bearing: 0, transitionDuration: 1200, transitionInterpolator: new FlyToInterpolator({ speed: 1.4 }) })) },
      updateTriggers: { getRadius: [india.run?.at, indiaSel], getFillColor: india.run?.at, getLineColor: indiaSel } }))
  }
  if (layers.india && india.data && (view.zoom ?? 0) >= 4.6) {
    const z = view.zoom ?? 0
    const rank = (id: number) => ({ NORMAL: 0, RISING: 1, WARNING: 2, DANGER: 3 } as const)[india.statuses.get(id)?.status ?? 'NORMAL']
    const cand = z >= 6.6 ? india.data.points : india.data.points.filter(p => rank(p.id) > 0 || p.id === indiaSel)
    const named = declutter(cand, d => [d.lng, d.lat], d => (d.id === indiaSel ? 1000 : rank(d.id) * 10))
    L.push(new TextLayer({ id: 'india-t', data: named.filter(d => d.id !== indiaSel), getPosition: (d: RiverPoint) => [d.lng, d.lat], getText: (d: RiverPoint) => (z >= 8.5 ? `${d.river} · ${d.near}` : d.river),
      getSize: 12, getPixelOffset: [10, 0], getTextAnchor: 'start', ...LABEL, updateTriggers: { getText: z >= 8.5 } }))
    const picked = indiaSel !== null ? india.points.get(indiaSel) : null
    if (picked) L.push(new TextLayer({ id: 'india-sel', data: [picked], getPosition: (d: RiverPoint) => [d.lng, d.lat], getText: (d: RiverPoint) => `${d.river} near ${d.near}\n${d.lat.toFixed(3)}°N  ${d.lng.toFixed(3)}°E`,
      getSize: 14, getPixelOffset: [16, -4], getTextAnchor: 'start', ...LABEL, backgroundPadding: [8, 5] as [number, number], lineHeight: 1.3 }))
  }
  if (layers.sat) {
    if (sentinel.s2) {
      L.push(new TileLayer({ id: 's2-live', data: sentinel.s2.tiles, minZoom: 6, maxZoom: 14, tileSize: 256, refinementStrategy: 'best-available',
        renderSubLayers: (p: any) => { const b = p.tile.boundingBox; return new BitmapLayer(p, { data: undefined, image: p.data, bounds: [b[0][0], b[0][1], b[1][0], b[1][1]], opacity: 0.95 }) } }))
    } else L.push(new BitmapLayer({ id: 's2', image: s2, bounds: ((D as any).s2bounds ?? D.bounds) as any, opacity: 0.85 }))
  }
  if (layers.rivers) L.push(new PathLayer({ id: 'rivers', data: D.network, getPath: (d: any) => d, getColor: [125, 211, 252, 110], widthMinPixels: 1 }))
  if (layers.rivers) L.push(new PathLayer({ id: 'gandak', data: [{ path: D.river.path }], getPath: (d: any) => d.path, getColor: [186, 230, 253, 200], widthUnits: 'pixels', getWidth: 2.4 }))
  if (layers.observed && mode === 'demo') {
    const seen = Object.entries(M.obsTimes).filter(([, t]) => Date.parse(t) <= sim).pop()
    if (seen) L.push(new BitmapLayer({ id: 'obs-' + seen[0], image: OBS_IMG[seen[0]], bounds: D.bounds as any, opacity: 0.95, tintColor: [90, 140, 255] }))
  }
  if (layers.observed && mode === 'live') {
    if (sentinel.s1) {
      // Sentinel-1 radar over the Gandak area, newest passes first. Water is picked out on the fly (very low backscatter).
      L.push(new TileLayer({ id: 's1-live', data: sentinel.s1.tiles, minZoom: 6, maxZoom: 14, tileSize: 256, refinementStrategy: 'best-available',
        getTileData: ({ url, signal }: any) => floodTile(url, signal).catch(() => null),
        renderSubLayers: (p: any) => { if (!p.data) return null; const b = p.tile.boundingBox; return new BitmapLayer(p, { data: undefined, image: p.data, bounds: [b[0][0], b[0][1], b[1][0], b[1][1]], opacity: 0.9 }) } }))
    } else L.push(new BitmapLayer({ id: 'obs-latest', image: o3, bounds: D.bounds as any, opacity: 0.9, tintColor: [90, 140, 255] }))
  }
  // Exercise town selected: show the normal river and the flooded river around that town instead of the regional extent.
  const selTown = sel && exerciseIds.has(sel) ? VBY.get(sel) ?? null : null
  const townLayer = useMemo(() => (spread && terrain && selTown ? townImage(spread, terrain, selTown, h) : null), [spread, terrain, selTown, h])
  const townInfo = useMemo(() => (spread && terrain && selTown ? townFacts(spread, terrain, selTown, h) : null), [spread, terrain, selTown, h])
  // Two polygons for the selected exercise town. The flood trajectory (red) is where the flood water goes at the selected
  // horizon. The evacuation zone (violet) is that flood plus watch-level cells plus a safety margin: the region to keep
  // empty. Phones are estimated, and drawn, only inside the evacuation zone.
  const zone = useMemo(() => (spread && terrain && selTown ? townZone(spread, terrain, selTown, h) : null), [spread, terrain, selTown, h])
  const zoneNow = useMemo(() => (spread && terrain && selTown ? townZone(spread, terrain, selTown, 0) : null), [spread, terrain, selTown])
  const evac = useMemo(() => (spread && terrain && selTown ? townZone(spread, terrain, selTown, h, 'evac') : null), [spread, terrain, selTown, h])
  const zoneKey = evac && selTown ? `${spreadSource}:${selTown.id}:${h}:${evac.areaKm2}` : ''
  useEffect(() => {
    if (!evac || !zoneKey || !evac.polygons.length) { setPop(null); return }
    let alive = true
    // show a density-based estimate straight away, then replace it with the live WorldPop total when it arrives
    const estimate = Math.round(evac.areaKm2 * FALLBACK_DENSITY_PER_KM2)
    setPop({ key: zoneKey, total: estimate, loading: true, source: 'estimate' })
    zonePopulation(evac.polygons)
      .then(total => { if (alive) setPop({ key: zoneKey, total, loading: false, source: 'worldpop' }) })
      .catch((e: Error) => { if (alive) setPop({ key: zoneKey, total: estimate, loading: false, source: 'estimate', error: e.message }) })
    return () => { alive = false }
  }, [zoneKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const popNow = pop && pop.key === zoneKey ? pop : null
  const phones = popNow?.total != null ? Math.round(popNow.total * PHONES_PER_PERSON) : null
  const iconCount = phones === null ? 0 : Math.min(phones, 400)
  const phonePts = useMemo(() => (evac && selTown && iconCount ? placePhones(evac, VILLAGES.map(v => [v.lng, v.lat] as [number, number]), iconCount, selTown.id * 131 + h) : []), [evac, selTown, iconCount, h])
  const bcKey = selTown ? `${selTown.id}:${h}` : ''
  const bcP = broadcast && broadcast.key === bcKey ? broadcast.p : null
  const startBroadcast = () => {
    if (!bcKey) return
    const key = bcKey, t0 = Date.now()
    setBroadcast({ key, p: 0 })
    const id = setInterval(() => {
      const p = Math.min(1, (Date.now() - t0) / 3200)
      setBroadcast({ key, p })
      if (p >= 1) clearInterval(id)
    }, 80)
  }
  if (townLayer && selTown) {
    const hzText = h === 0 ? 'now' : `+${h} h`
    L.push(new BitmapLayer({ id: `town-river-${selTown.id}`, image: townLayer.canvas, bounds: townLayer.bounds, opacity: 0.95, textureParameters: { minFilter: 'nearest', magFilter: 'nearest' } as any }))
    if (showEvac && evac) L.push(new PolygonLayer({ id: `evac-${selTown.id}-${h}`, data: evac.polygons, getPolygon: (d: any) => d, filled: true, stroked: true, getFillColor: [124, 58, 237, 55], getLineColor: [109, 40, 217, 255], getLineWidth: 3, lineWidthUnits: 'pixels', lineJointRounded: true }))
    if (showFlood && zoneNow && h > 0) L.push(new PolygonLayer({ id: 'zone-now', data: zoneNow.polygons, getPolygon: (d: any) => d, filled: false, stroked: true, getLineColor: [251, 146, 60, 235], getLineWidth: 2, lineWidthUnits: 'pixels' }))
    if (showFlood && zone) L.push(new PolygonLayer({ id: `flood-${selTown.id}-${h}`, data: zone.polygons, getPolygon: (d: any) => d, filled: true, stroked: true, getFillColor: [220, 38, 38, 95], getLineColor: [185, 28, 28, 255], getLineWidth: 2.5, lineWidthUnits: 'pixels', lineJointRounded: true }))
    if (showEvac && showPhones && phonePts.length) {
      L.push(new IconLayer({
        id: `phones-${selTown.id}-${h}`, data: phonePts.map((p, i) => ({ p, i })), getPosition: (d: any) => d.p, sizeUnits: 'pixels', getSize: 24, sizeMinPixels: 12, sizeMaxPixels: 34,
        getIcon: (d: any) => (bcP !== null && d.i / phonePts.length < bcP ? PHONE_OK : PHONE_ALERT), updateTriggers: { getIcon: [bcP, phonePts.length] },
      }))
    }
    if (showFlood && zone?.centroid) {
      L.push(new TextLayer({ id: 'flood-label', data: [{ p: zone.centroid, t: `Flood trajectory · ${hzText}\n${zone.areaKm2.toLocaleString()} km²` }], getPosition: (d: any) => d.p, getText: (d: any) => d.t, ...LABEL, getSize: 13, getPixelOffset: [0, -26], outlineWidth: 4, outlineColor: [127, 29, 29, 240], lineHeight: 1.2 }))
    }
    // anchor the evacuation label at the top edge of its polygon so it never sits on the flood label
    const evacTop = evac && evac.centroid ? (() => { let best: [number, number] | null = null; for (const pl of evac.polygons) for (const v of pl[0]) if (!best || v[1] > best[1]) best = v; return best ? [evac.centroid![0], best[1]] as [number, number] : null })() : null
    if (showEvac && evac?.centroid) {
      const ph = showPhones && phones !== null ? ` · ≈ ${phones.toLocaleString()} phones` : ''
      L.push(new TextLayer({ id: 'evac-label', data: [{ p: evacTop ?? evac.centroid, t: `Evacuation zone · keep clear · ${hzText}\n${evac.areaKm2.toLocaleString()} km²${ph}` }], getPosition: (d: any) => d.p, getText: (d: any) => d.t, ...LABEL, getSize: 13, getPixelOffset: [0, -4], outlineWidth: 4, outlineColor: [76, 29, 149, 240], lineHeight: 1.2 }))
    }
  }
  if (layers.predicted && !townLayer && extents && tb && extents[h].canvas) L.push(new BitmapLayer({ id: 'pred-' + h + '-' + run!.now, image: extents[h].canvas, bounds: tb, opacity: 1, textureParameters: { minFilter: 'nearest', magFilter: 'nearest' } as any }))
  if (layers.roads) L.push(new PathLayer({ id: 'roads', data: D.roads, getPath: (d: any) => d.path, getColor: [226, 232, 240, 110], widthMinPixels: 1 }))
  if (layers.rain && run) {
    const pts = M.rainPoints.map(([lat, lng]) => ({ lat, lng, mm: run.ctx.rain48 }))
    L.push(new ScatterplotLayer({ id: 'rain', data: pts, getPosition: (d: any) => [d.lng, d.lat], getRadius: (d: any) => 3000 + d.mm * 90, stroked: true, getFillColor: [147, 197, 253, 30], getLineColor: [191, 219, 254, 190], lineWidthMinPixels: 1, updateTriggers: { getRadius: run.now } }))
  }
  if (layers.shelters) L.push(new ScatterplotLayer({ id: 'pois', data: M.pois, getPosition: (d: any) => [d.x, d.y], getRadius: 2.6, radiusUnits: 'pixels', getFillColor: [52, 211, 153, 200], pickable: true }))
  // the selected village's route, in the shape the Mapbox views draw
  const mapboxRoute = useMemo<SharedRoute | null>(() => {
    const rt = selR ? routes.get(selR.id) : null, vv = selR ? VBY.get(selR.id) : null
    if (!selR || !rt || !vv) return null
    return { v: vv.name, d: (vv as any).district || undefined, lvl: selR.level, when: selR.impactH === null ? '' : windowText(selR), at: new Date().toISOString(),
      from: [vv.lat, vv.lng], to: [rt.shelter.y, rt.shelter.x], shelter: rt.shelter.n, km: rt.km, path: simplify(rt.path, 40) }
  }, [selR, routes]) // eslint-disable-line react-hooks/exhaustive-deps
  const [gDrive, setGDrive] = useState<{ km: number; minutes: number } | null>(null)
  useEffect(() => {
    setGDrive(null)
    if (!mapboxRoute) return
    const ac = new AbortController()
    googleWalk(mapboxRoute.from, mapboxRoute.to, ac.signal, 'driving').then(d => { if (!ac.signal.aborted) setGDrive(d ? { km: d.km, minutes: d.minutes } : null) })
    return () => ac.abort()
  }, [mapboxRoute?.from[0], mapboxRoute?.from[1], mapboxRoute?.to[0], mapboxRoute?.to[1]]) // eslint-disable-line react-hooks/exhaustive-deps
  const real = useRealRoute(mapboxRoute)   // walkable path + exact safe place; the model's own path is only a terrain estimate
  const selRoute = sel ? routes.get(sel) : null
  const shelterPt = selRoute ? (real.place ? { ...selRoute.shelter, n: real.place.name, x: real.place.lng, y: real.place.lat } : selRoute.shelter) : null
  const hasReal = !!(real.walk || real.drive)
  if (layers.route && selRoute) {
    // Real routes only: on foot (blue, dotted) and by car (green), both along mapped roads and paths. The model's own path is a
    // terrain estimate that can cut across fields and rivers, so it is drawn (amber, dashed) only if no real route was found.
    if (real.walk) {
      L.push(new PathLayer({ id: 'walk-glow', data: [{ path: real.walk.path }], getPath: (d: any) => d.path, getColor: [255, 255, 255, 200], getWidth: 7, widthUnits: 'pixels', capRounded: true, jointRounded: true }))
      L.push(new PathLayer({ id: 'walk', data: [{ path: real.walk.path }], getPath: (d: any) => d.path, getColor: [23, 105, 224, 255], getWidth: 4, widthUnits: 'pixels', capRounded: true, jointRounded: true, getDashArray: [2, 2], extensions: ROUTE_EXTENSIONS }))
    }
    if (real.drive) {
      L.push(new PathLayer({ id: 'drive-glow', data: [{ path: real.drive.path }], getPath: (d: any) => d.path, getColor: [255, 255, 255, 220], getWidth: 10, widthUnits: 'pixels', capRounded: true, jointRounded: true }))
      L.push(new PathLayer({ id: 'drive', data: [{ path: real.drive.path }], getPath: (d: any) => d.path, getColor: [18, 128, 92, 255], getWidth: 6, widthUnits: 'pixels', capRounded: true, jointRounded: true }))
    }
    if (!hasReal && !real.busy) {
      L.push(new PathLayer({ id: 'route', data: [selRoute], getPath: (d: any) => d.path, getColor: [251, 191, 36, 255], getWidth: 3.5, widthUnits: 'pixels', capRounded: true, jointRounded: true, getDashArray: [5, 4], extensions: ROUTE_EXTENSIONS }))
    }
    L.push(new ScatterplotLayer({ id: 'shelter-sel', data: [shelterPt], getPosition: (d: any) => [d.x, d.y], getRadius: 8, radiusUnits: 'pixels', getFillColor: [52, 211, 153], stroked: true, getLineColor: [255, 255, 255], lineWidthMinPixels: 2 }))
    L.push(new TextLayer({ id: 'shelter-t', data: [shelterPt], getPosition: (d: any) => [d.x, d.y], getText: (d: any) => latinOr(d.n, 'Safe place'), getSize: 13, getPixelOffset: [12, 0], getTextAnchor: 'start', ...LABEL }))
  }
  if (layers.villages) L.push(new ScatterplotLayer({
    id: 'villages', data: VILLAGES, getPosition: (d: any) => [d.lng, d.lat], radiusUnits: 'pixels',
    getRadius: (d: any) => { const l = risk.get(d.id)?.levelAt[h] ?? 'LOW'; return d.id === sel ? 9 : l === 'LOW' ? 2.2 : l === 'MEDIUM' ? 4.5 : 6 },
    getFillColor: (d: any) => { const l = risk.get(d.id)?.levelAt[h] ?? 'LOW'; return [...LEVEL_RGB[l], l === 'LOW' ? 150 : 245] as any }, stroked: true,
    getLineColor: (d: any) => (d.id === sel ? [255, 255, 255, 255] : [8, 10, 14, 120]), lineWidthMinPixels: 1, pickable: true,
    onClick: (i: PickingInfo) => pick((i.object as any).id), updateTriggers: { getFillColor: [run?.now, h], getRadius: [run?.now, h, sel], getLineColor: sel },
  }))
  if (layers.villages && (view.zoom ?? 0) >= 9.4) L.push(new TextLayer({ id: 'vt', data: declutter(VILLAGES.filter(v => (risk.get(v.id)?.levelAt[h] ?? 'LOW') !== 'LOW' || v.id === sel), d => [d.lng, d.lat], d => (d.id === sel ? 1000 : ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].indexOf(risk.get(d.id)?.levelAt[h] ?? 'LOW'))), getPosition: (d: any) => [d.lng, d.lat], getText: (d: any) => latinOr(d.name, ''), getSize: 12, getPixelOffset: [10, 0], getTextAnchor: 'start', ...LABEL, updateTriggers: { getText: [run?.now, h] } }))
  if (run) {
    const sd = M.stations.map((s, i) => ({ ...s, f: run.stations[i] }))
    L.push(new ScatterplotLayer({ id: 'stations', data: sd, pickable: true, getPosition: (d: any) => [d.lng, d.lat], getRadius: 4.5, radiusUnits: 'pixels', getFillColor: [255, 255, 255], stroked: true, getLineColor: [15, 23, 42], lineWidthMinPixels: 1.5 }))
    if ((view.zoom ?? 0) >= 5.8) L.push(new TextLayer({ id: 'st-t', data: declutter(sd, d => [d.lng, d.lat], () => 1, 150, 26), getPosition: (d: any) => [d.lng, d.lat], getText: (d: any) => d.label.replace(' barrage', '').replace(', Nepal', ''), getSize: 13, getPixelOffset: [11, 0], getTextAnchor: 'start', ...LABEL, updateTriggers: { getText: [run.now, h] } }))
  }

  const tick = (k: keyof typeof layers) => setLayers(s => ({ ...s, [k]: !s[k] }))

  return (
    <div className={'app live ' + mode} style={{ ['--top' as any]: `${topH + 18}px` }}>
      <DeckGL viewState={view} onViewStateChange={(e: any) => setView(e.viewState)} controller layers={L} getCursor={({ isHovering }) => (isHovering ? 'pointer' : 'grab')}
        getTooltip={({ object, layer }: any) => !object ? null : layer?.id === 'villages' ? { text: `${object.name} · ${risk.get(object.id)?.levelAt[h] ?? 'LOW'} at ${HLABEL[h]}` } : layer?.id === 'india-pts' ? { text: `${object.river} near ${object.near}: ${india.statuses.has(object.id) ? INDIA_WORD[india.statuses.get(object.id)!.status] : 'Data unavailable'}` } : layer?.id === 'pois' ? { text: `${object.n} (${object.a === 'h' ? 'hospital' : 'school / college'})` } : layer?.id === 'stations' ? { text: `${object.label}: ${fmtQ(object.f.q[72 + h])} m³/s, ${object.f.trend.toLowerCase()}` } : null} />

      {mapView === 'current' && layers.predicted && !townLayer && extents && <div className="hazard-legend" aria-label="Predicted flood colours">
        <b>Predicted flood at {HLABEL[h]}</b>
        <span><i style={{ background: 'rgba(255,236,90,.55)' }} />Watch</span>
        <span><i style={{ background: '#facc15' }} />Likely</span>
        <span><i style={{ background: '#f97316' }} />Very likely</span>
        <span><i style={{ background: '#dc2626' }} />Almost certain</span>
        <em>{extents[h].km2.toLocaleString()} km² predicted water</em>
      </div>}
      {mapView !== 'current' && <MapboxLive mode={mapView} center={[view.longitude, view.latitude]} route={mapboxRoute} />}

      <div className="ltop" ref={topRef}>
      <div className="lv-row">
        <section className="lv-card">
          <div className="lv-head">
            <AppBrand onClick={onHome} />
          </div>
        </section>
          <div className="lv-actions">
          <div className="lv-more">
            <button className="lv-icon" aria-label="More" onClick={() => setMenu(m => !m)}><FiMoreHorizontal /></button>
            {menu && <div className="lv-menu" onClick={() => setMenu(false)}>
              {MAPBOX_TOKEN && <>
                <div className="lv-menu-label" style={{ padding: '6px 12px 2px', font: '700 11px Inter,sans-serif', letterSpacing: '.04em', textTransform: 'uppercase', opacity: .6 }}>Map view</div>
                {([['current', 'Current map'], ['2d', '2D map'], ['3d', '3D map']] as const).map(([k, l]) => <button key={k} aria-pressed={mapView === k} onClick={() => setMapView(k)} style={mapView === k ? { fontWeight: 700 } : undefined}>{mapView === k ? '✓ ' : ''}{l}</button>)}
              </>}
              <button onClick={() => setDetail(d => !d)}>{detail ? 'Hide details' : 'Show details'}</button>
              <button onClick={() => setPhoto(true)}><FiCamera /> Check a flood photo</button>
              <button onClick={() => setShowLayers(x => !x)}><FiLayers /> Map layers</button>
              <button onClick={onValidate}>2026 validation</button>
              <button onClick={() => window.open('/route?sim=1', '_blank')}><FiCamera /> Try the AR route near you</button>
            </div>}
          </div>
        </div>
      </div>

      {/* ---------- pipeline ---------- */}
      {detail && <div className="pipe" ref={pipeRef} aria-label="Prediction pipeline">
        {STAGES.map((s, i) => {
          const val = !run ? '' : [
            `${run.inputs.observations} obs`, run.river, `+24h ${fmtQ(run.stations[run.stations.length - 1].q[96])}`, `${extents?.[h].km2 ?? '…'} km²`, `${atRiskH} villages`,
            `${[...routes.values()].filter(Boolean).length} routes`, `${run.villages.filter(v => v.level === 'CRITICAL').length} critical`,
             `${queue.filter(q => !alerts[q.id] || alerts[q.id].stage === 'review').length} waiting`, anyContacted ? (mode === 'demo' ? 'call simulated' : 'call dispatched') : anyApproved ? 'approved' : 'none yet', mode === 'demo' ? (anyContacted ? 'tracking simulated' : 'none yet') : anyIncident ? 'tracking' : 'none yet'][i]
          const on = i < 7 ? !!run : i === 7 ? queue.length > 0 : i === 8 ? anyApproved : anyContacted || anyIncident
           return <div key={s} className={'stage' + (i < 7 ? ' model' : ' human') + (on ? ' on' : '') + (i === 7 ? ' gate' : '')}><span className="sn">{i + 1}</span><span className="st">{mode === 'demo' ? `Simulated ${i === 0 ? 'data' : s.toLowerCase()}` : s}</span><span className="sv">{val}</span></div>
        })}
      </div>}
      </div>

      {err && <div className="lerr"><FiAlertTriangle /> {err}</div>}
      {replayNote && !err && !replayHidden && <div className="lerr info replay-note" title={replayNote}><FiAlertTriangle /> <span>Showing the September 2026 replay · live river feed resumes automatically</span><button className="ghost" aria-label="Dismiss" onClick={() => setReplayHidden(true)}><FiX /></button></div>}
      {!run && !err && <div className="lerr info"><FiRefreshCw className="spin" /> Fetching river and rain data, running the model…</div>}

      <button className={'rail-toggle rail-toggle-left' + (showLeftPanel ? ' open' : '')} onClick={() => setShowLeftPanel(v => !v)} aria-expanded={showLeftPanel} aria-controls="live-left-panel">
        {showLeftPanel ? <FiChevronLeft /> : <FiChevronRight />}<span>{showLeftPanel ? 'Hide rivers' : 'Rivers'}</span>
      </button>
      <button className={'rail-toggle rail-toggle-right' + (showRightPanel ? ' open' : '')} onClick={() => setShowRightPanel(v => !v)} aria-expanded={showRightPanel} aria-controls="live-right-panel">
        <span>{showRightPanel ? 'Hide alerts' : 'Alerts'}</span>{showRightPanel ? <FiChevronRight /> : <FiChevronLeft />}
      </button>

      {/* ---------- left: forecast + inputs + impact timeline ---------- */}
      {(run || india.data) && <aside id="live-left-panel" className={'lpanel left' + (showLeftPanel ? ' panel-visible' : ' panel-hidden')}>
        <IndiaCard india={india} sel={indiaSel} onSelect={id => { setIndiaSel(id); const p = india.points.get(id); if (p) setView(v => ({ ...v, longitude: p.lng, latitude: p.lat, zoom: Math.max(v.zoom ?? 0, 8), pitch: 0, bearing: 0, transitionDuration: 1200, transitionInterpolator: new FlyToInterpolator({ speed: 1.4 }) })) }} onClear={() => setIndiaSel(null)} />
        {run && detail && <>
        <Forecast run={run} />
        <ImpactTimeline run={run} onPick={pick} sel={sel} />
        <section>
          <div className="kicker">Inputs this run</div>
          <dl className="kv small">
            <dt>River</dt><dd>{run.inputs.byType.river_discharge ?? 0} GloFAS discharge values, 7 points{mode === 'demo' ? ' (2026 replay)' : ''}</dd>
            <dt>Rain</dt><dd>{run.inputs.byType.rainfall ?? 0} daily values, 4 points in Nepal{mode === 'demo' ? ' (ERA5 2026 replay, no rain forecast used)' : ' (incl. 3-day forecast)'}</dd>
            <dt>Terrain</dt><dd>Copernicus DEM height above channel, JRC normal water</dd>
            <dt>Model</dt><dd>v{run.version}, calibrated on 3 Sentinel-1 flood maps</dd>
          </dl>
          {mode === 'live' && <MonitorStatus />}
          {mode === 'live' && <p className="note">GloFAS is a global river model, not a gauge. There is no public real-time gauge feed for the Gandak, so "now" means GloFAS's latest daily estimate.</p>}
          {mode === 'demo' && <p className="note">Simulation: the September 2026 flood replayed as if it were happening now. The model only sees data up to the simulated clock.</p>}
        </section>
        </>}
      </aside>}

      {/* ---------- right: alert queue or village ---------- */}
      {run && (selR || queue.length > 0 || detail) && <aside id="live-right-panel" className={'lpanel right' + (showRightPanel ? ' panel-visible' : ' panel-hidden')}>
        {selR ? <VillagePanel r={selR} route={routes.get(selR.id) ?? null} run={run} mode={mode} h={h} st={alerts[selR.id]} setSt={s => setAlerts(a => ({ ...a, [selR.id]: { ...(a[selR.id] ?? {}), ...s } as AlertState }))} onClose={closeSel} onOpenIncident={onOpenIncident} exercise={exerciseIds.has(selR.id)} googleDrive={gDrive} realInfo={real} townInfo={townInfo} zoneInfo={zone && evac && selTown ? { floodKm2: zone.areaKm2, evacKm2: evac.areaKm2, population: popNow?.total ?? null, phones, loading: !!popNow?.loading, source: popNow?.source ?? 'estimate', error: popNow?.error, progress: bcP, icons: phonePts.length } : null} spreadUi={{ source: spreadSource, setSource: setSpreadSource, liveOk, showFlood, setShowFlood, showEvac, setShowEvac, showPhones, setShowPhones }} onBroadcast={startBroadcast} />
          : <AlertQueue exerciseIds={exerciseIds} queue={queue} alerts={alerts} onView={pick} onDismiss={id => setAlerts(a => ({ ...a, [id]: { stage: 'dismissed' } }))} onOpenIncident={onOpenIncident} mode={mode} />}
        {stats && detail && <section>
          <div className="kicker">Potentially affected at {HLABEL[h]}</div>
          <dl className="kv small">
            <dt>Flood area</dt><dd>{extents![h].km2.toLocaleString()} km² predicted water</dd>
            <dt>Villages</dt><dd>{atRiskH} of 291 tracked</dd>
            <dt>Roads</dt><dd>{stats.roadsHit} mapped roads, {stats.roadKm} km under predicted water</dd>
            <dt>Schools</dt><dd>{stats.schools} schools or colleges</dd>
            <dt>Hospitals</dt><dd>{stats.hospitals}</dd>
            <dt>People</dt><dd>Not estimated: no village population data loaded</dd>
          </dl>
        </section>}
      </aside>}

      {photo && <PhotoCheck onClose={() => setPhoto(false)} />}
      <footer className="lv-dock">
        <span className="lv-hz-label" title="The horizon applies to the Gandak village model and the flood layer, not to the India river points, which always show the 7-day forecast.">Gandak village forecast</span>
        <div className="lv-hz" role="group" aria-label="Gandak village forecast horizon">
          {HORIZONS.map(x => <button key={x} className={h === x ? 'on' : ''} onClick={() => setH(x)}>{x === 0 ? 'Now' : `+${x}h`}</button>)}
        </div>
        <span className="lv-sep" />
        {mode === 'demo' ? <>
          <button className="lv-icon" aria-label={paused ? 'Play' : 'Pause'} onClick={() => setPaused(p => !p)}>{paused ? <FiPlay /> : <FiPause />}</button>
          <button className="lv-icon" aria-label="Skip 3 hours" onClick={runNow} disabled={running}><FiSkipForward /></button>
          <button className="lv-icon" aria-label="Restart" onClick={restart}><FiRotateCcw /></button>
          <button className="lv-speed" aria-label="Speed" onClick={() => { const n = period === 30 ? 8 : 30; setPeriod(n); setNextAt(Date.now() + n * 1000) }}>{period === 8 ? '4×' : '1×'}</button>
        </> : <button className="lv-icon" aria-label="Run model now" onClick={runNow} disabled={running}><FiRefreshCw className={running ? 'spin' : ''} /></button>}
      </footer>
      {detail && <ol className="feed lv-feed">{events.slice(0, 4).map((e, i) => <li key={i} className={e.kind}><span className="dim">{fmtIST(e.t, mode === 'demo')}</span> {e.text}</li>)}</ol>}
      <div className="lv-attr">Imagery Esri, Maxar · River GloFAS · Terrain Copernicus DEM</div>
      {showLayers && <div className="lpop">
        {([['india', 'India river points'], ['predicted', mode === 'demo' ? 'Simulated prediction' : 'Predicted flood'], ['observed', mode === 'demo' ? 'Observed flood (Sentinel-1, 2026)' : sentinel.s1 ? `Sentinel-1 radar flood water (${new Date(sentinel.s1.when).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, live)` : 'Last radar flood map (3 Oct)'], ['villages', 'Village risk'], ['route', 'Evacuation route'], ['shelters', 'Schools, hospitals'], ['roads', 'Roads'], ['rain', 'Rainfall (48 h)'], ['rivers', 'Rivers'], ['sat', sentinel.s2 ? `Sentinel-2 imagery (${new Date(sentinel.s2.when).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}, live)` : 'Satellite imagery']] as const).map(([k, l]) => <label key={k} className="tg"><input type="checkbox" checked={layers[k]} onChange={() => tick(k)} /><span>{l}</span></label>)}
        <div className="legend2">
          <div><i className={'sw2 ' + (mode === 'demo' ? 'sim' : 'pred')} />{mode === 'demo' ? 'SIMULATED: model output on replayed data' : 'PREDICTED: model output'}</div>
          <div><i className="sw2 obs" />OBSERVED: Sentinel-1 radar</div>
          <div className="dots">{(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as Level[]).map(l => <span key={l}><i style={{ background: `rgb(${LEVEL_RGB[l].join(',')})` }} />{l}</span>)}</div>
        </div>
      </div>}
    </div>
  )
}

type MonitorStatus = { running: boolean; intervalMin: number; lastOkAt: string | null; nextRunAt: string | null; runs: number; lastError: string; points: number; counts: { normal: number; rising: number; warning: number; danger: number } | null }
/** The local scheduled monitor (the job the AWS Lambda used to run): when it last updated and when it runs next. */
function useMonitor() {
  const [m, setM] = useState<MonitorStatus | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => fetch('/monitor/status').then(r => (r.ok ? r.json() : null)).then(v => { if (alive && v) setM(v) }).catch(() => {})
    load()
    const id = setInterval(load, 20_000)
    return () => { alive = false; clearInterval(id) }
  }, [])
  return m
}
const hhmm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '…')

function IndiaCard({ india, sel, onSelect, onClear }: { india: ReturnType<typeof useIndiaRivers>; sel: number | null; onSelect: (id: number) => void; onClear: () => void }) {
  const { run, summary, attention, points, statuses, busy, stale, err, waitSeconds } = india
  const monitor = useMonitor()
  const selP = sel !== null ? points.get(sel) : null, selS: PointStatus | undefined = sel !== null ? statuses.get(sel) : undefined
  const label = run ? (stale ? `Data from ${new Date(run.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' })} · retrying for the latest` : run.source === 'server' ? `JalNetra monitor snapshot · ${fmtIST(run.at)}` : `GloFAS forecast for ${new Date(run.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · fetched ${fmtIST(run.at, false)}`) : null
  return (
    <section className="india-card">
      <div className="kicker live">India river network</div>
      {!selP && !india.data && !err && <p className="note"><FiRefreshCw className="spin" /> Loading the river list…</p>}
      {india.data && !run && !err && <p className="note"><FiRefreshCw className="spin" /> Checking {india.data.points.length} river points across India…</p>}
      {err && !run && <p className="err"><FiAlertTriangle /> {err} No conditions are inferred.</p>}
      {selP ? <IndiaDetail p={selP} s={selS} onClose={onClear} /> : summary && run && <>
        <div className={'rwhead ' + summary.worst}>{summary.headline}</div>
        {summary.sub && <p className="note tight">{summary.sub}</p>}
        <div className="rwcounts">{(['DANGER', 'WARNING', 'RISING', 'NORMAL'] as Status[]).map(s => <div key={s} className={s}><b>{summary.by[s]}</b><span>{s === 'NORMAL' ? 'Normal' : INDIA_WORD[s]}</span></div>)}</div>
        {attention.length > 0 && <ol className="rwlist">{attention.slice(0, 5).map(({ s, p, more }) => (
          <li key={s.id}><button onClick={() => onSelect(s.id)}><i style={{ background: `rgb(${INDIA_RGB[s.status].join(',')})` }} /><span><b>{p.river}</b> near {p.near}<small>{INDIA_WORD[s.status]} · {s.trend === 'falling' ? 'high but falling' : s.trend}{more > 0 ? ` · +${more} more point${more > 1 ? 's' : ''} on this river` : ''}</small></span></button></li>))}</ol>}
      </>}
      {monitor && <p className="note tight monitor-line"><span className={'mon-dot' + (monitor.running ? ' run' : monitor.lastError ? ' warn' : '')} />Live monitor: {monitor.running ? 'updating now' : `updated ${hhmm(monitor.lastOkAt)} IST`} · next {hhmm(monitor.nextRunAt)} · every {monitor.intervalMin} min · {monitor.points} river points{monitor.lastError ? ` · retrying (${monitor.lastError})` : ''}</p>}
      {label && <p className="note tight">{label}{busy ? ' · updating…' : waitSeconds > 0 && stale ? ` · next try in ${waitSeconds}s` : ''}</p>}
      {err && run && <p className="note tight dim">{err}</p>}
    </section>
  )
}

function Forecast({ run }: { run: ModelRun }) {
  const [open, setOpen] = useState<number | null>(null)
  return (
    <section>
      <div className="kicker">River forecast · m³/s</div>
      <table className="fc">
        <thead><tr><th></th><th>Now</th><th>+6h</th><th>+12h</th><th>+24h</th></tr></thead>
        <tbody>{run.stations.map((s, i) => (
          <Fragment key={s.name}>
            <tr className="fr" onClick={() => setOpen(open === i ? null : i)}>
              <td>{open === i ? <FiChevronDown /> : <FiChevronRight />} {s.label.replace(' barrage', '').replace(', Nepal', '')}<span className={'tr ' + (s.trend.startsWith('Rising') ? 'up' : s.trend === 'Falling' ? 'down' : '')}>{s.trend.startsWith('Rising') ? '↑' : s.trend === 'Falling' ? '↓' : '→'}</span></td>
              <td>{fmtQ(s.q0)}</td>{[6, 12, 24].map((hz, k) => <td key={hz} className={'c-' + s.conf[k + 2]}>{fmtQ(s.q[72 + hz])}</td>)}
            </tr>
            {open === i && <tr><td colSpan={5}><StationDetail s={s} /></td></tr>}
          </Fragment>
        ))}</tbody>
      </table>
      <p className="note">Colour of a forecast = confidence: <span className="c-High">high</span>, <span className="c-Medium">medium</span>, <span className="c-Low">low</span>. Tap a station for the breakdown.</p>
    </section>
  )
}
function StationDetail({ s }: { s: ModelRun['stations'][number] }) {
  const w = 300, hgt = 86, xs = s.q.map((_, i) => i), mx = Math.max(...s.hi) * 1.04, mn = Math.min(...s.lo) * 0.96
  const X = (i: number) => 4 + (i / (xs.length - 1)) * (w - 8), Y = (v: number) => 6 + (1 - (v - mn) / (mx - mn)) * (hgt - 20)
  const line = (a: number[], from = 0, to = a.length) => a.slice(from, to).map((v, i) => `${i ? 'L' : 'M'}${X(i + from).toFixed(1)},${Y(v).toFixed(1)}`).join('')
  const band = line(s.hi, 72) + s.lo.map((v, i) => [i, v] as const).slice(72).reverse().map(([i, v]) => `L${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join('') + 'Z'
  return (
    <div className="sdet">
      <svg viewBox={`0 0 ${w} ${hgt}`} className="spark" role="img" aria-label={`Forecast at ${s.label}`}>
        <path d={band} fill="rgba(34,211,238,.16)" />
        <path d={line(s.q, 0, 73)} fill="none" stroke="#e6edf3" strokeWidth="1.6" />
        <path d={line(s.q, 72)} fill="none" stroke="#22d3ee" strokeWidth="1.6" strokeDasharray="4 3" />
        <line x1={X(72)} x2={X(72)} y1="4" y2={hgt - 14} stroke="#e6edf3" strokeOpacity=".5" />
        <text x={X(72) + 3} y="12" fontSize="9" fill="#9aa7b4">now</text>
        <text x="4" y={hgt - 2} fontSize="9" fill="#66727f">−72 h</text><text x={w - 4} y={hgt - 2} fontSize="9" fill="#66727f" textAnchor="end">+48 h</text>
      </svg>
      <table className="parts"><thead><tr><th>Change vs now</th>{[6, 12, 24].map(hz => <th key={hz}>+{hz}h</th>)}</tr></thead><tbody>
        {(['trend', 'route', 'rain', 'glofas'] as const).map(k => (
          <tr key={k}><td>{{ trend: 'Recent trend', route: 'Water from upstream', rain: 'Rain in Nepal', glofas: 'GloFAS forecast' }[k]}</td>{[2, 3, 4].map(j => { const v = s.parts[j][k]; return <td key={j}>{v === null ? '–' : `${v >= 0 ? '+' : ''}${fmtQ(v)}`}</td> })}</tr>
        ))}
      </tbody></table>
      <p className="note">Trend is damped over 10 h. Upstream water travels at {M.celerity} km/h (fitted to the 2026 peak timing). Rain adds {M.rain.kappa} m³/s per mm, peaking {M.rain.tp} h later. GloFAS, when available, takes over with lead time.</p>
    </div>
  )
}

function ImpactTimeline({ run, onPick, sel }: { run: ModelRun; onPick: (id: number) => void; sel: number | null }) {
  const items = run.villages.filter(v => v.impactH !== null && v.impactH <= 24 && v.level !== 'LOW').sort((a, b) => (a.level === b.level ? a.impactH! - b.impactH! : a.level === 'CRITICAL' ? -1 : b.level === 'CRITICAL' ? 1 : a.level === 'HIGH' ? -1 : 1))
  const B = [[0, 0, 'NOW'], [1, 3, '+3H'], [4, 6, '+6H'], [7, 12, '+12H'], [13, 24, '+24H']] as const
  return (
    <section>
      <div className="kicker">Time to impact · {items.length} village{items.length === 1 ? '' : 's'} within 24 h</div>
      {!items.length ? <div className="empty">No village is predicted to flood in the next 24 hours.</div> : <div className="itl">
        {B.map(([a, b, l]) => { const xs = items.filter(v => v.impactH! >= a && v.impactH! <= b); return (
          <div key={l} className="col"><div className="ch">{l}<span>{xs.length}</span></div>
            {xs.slice(0, 7).map(v => <button key={v.id} className={'chip ' + v.level + (sel === v.id ? ' sel' : '')} onClick={() => onPick(v.id)} title={`${VBY.get(v.id)!.name}: ${v.level}, impact ${impactText(v)}`}>{VBY.get(v.id)!.name}</button>)}
            {xs.length > 7 && <div className="more">+{xs.length - 7} more</div>}
          </div>) })}
      </div>}
    </section>
  )
}

function AlertQueue({ exerciseIds, queue, alerts, onView, onDismiss, onOpenIncident, mode }: { exerciseIds: Set<number>; queue: VillageRisk[]; alerts: Record<number, AlertState>; onView: (id: number) => void; onDismiss: (id: number) => void; onOpenIncident: (id: string) => void; mode: Mode }) {
  const real = queue.filter(q => !exerciseIds.has(q.id)), practice = queue.filter(q => exerciseIds.has(q.id))
  const spot = (e: React.MouseEvent<HTMLLIElement>) => { const b = e.currentTarget.getBoundingClientRect(); e.currentTarget.style.setProperty('--mx', `${e.clientX - b.left}px`); e.currentTarget.style.setProperty('--my', `${e.clientY - b.top}px`) }
  const card = (r: VillageRisk, i: number) => {
    const v = VBY.get(r.id)!, st = alerts[r.id], ex = exerciseIds.has(r.id)
    return (
      <li key={r.id} className={r.level + ' card-spotlight'} onMouseMove={spot}>
        <div className="aqh"><span className="n">{i + 1}</span><b>{v.name}</b><span className={'pill lv-' + r.level}>{r.level}</span><span className="dim">water in {impactText(r).replace('~', '')}</span></div>
        <div className="aqm">{Math.round(r.pMax * 100)}% chance · {r.action}{st && st.stage !== 'review' ? ` · ${st.stage}` : ''}</div>
        <div className="aqb">
          <button onClick={() => onView(r.id)}>View route</button>
          <button className="pri" onClick={() => onView(r.id)}>{mode === 'demo' ? 'Simulate approval' : 'Approve'}</button>
          <button className="ghost" onClick={() => onDismiss(r.id)}>{ex ? 'Reject' : 'Dismiss'}</button>
          {mode === 'live' && st?.incident?.id && <button className="ghost" onClick={() => onOpenIncident(st.incident!.id)}><FiExternalLink /> Incident</button>}
        </div>
      </li>
    )
  }
  return (
      <section className="queue">
       <div className="queue-head"><span className="kicker live">Alerts</span><span className="queue-count">{real.length} live · {practice.length} exercise</span></div>

       <div className="queue-sec">
        <h3>Needs your approval</h3>
        {real.length ? <ol className="aq">{real.map(card)}</ol> : <p className="empty">Nothing right now. The model has not raised a HIGH or CRITICAL alert.</p>}
      </div>

      {practice.length > 0 && <div className="queue-sec practice">
        <h3>Exercise alerts <span className="pill sim">REHEARSAL</span></h3>
        <p className="note tight">Practise review, approval and the call. Approving places one call, only to the configured demo phone. Anyone with this link can approve.</p>
        <ol className="aq">{practice.map(card)}</ol>
      </div>}
    </section>
  )
}

function VillagePanel({ r, route, run, mode, h, st, setSt, onClose, onOpenIncident, exercise, googleDrive, realInfo, townInfo, zoneInfo, spreadUi, onBroadcast }: { townInfo?: TownFacts | null; zoneInfo?: ZoneUi | null; spreadUi?: SpreadUi; onBroadcast?: () => void; googleDrive?: { km: number; minutes: number } | null; realInfo?: { walk: { km: number; minutes: number } | null; drive: { km: number; minutes: number } | null; busy: boolean; note: string }; exercise: boolean; r: VillageRisk; route: Route | null; run: ModelRun; mode: Mode; h: number; st?: AlertState; setSt: (s: Partial<AlertState>) => void; onClose: () => void; onOpenIncident: (id: string) => void }) {
  const v = VBY.get(r.id)!
  const [why, setWhy] = useState(false)
  const [review, setReview] = useState(false)
  const [routeMore, setRouteMore] = useState(false)
  const [msg, setMsg] = useState(() => hindiAlert(v.name, r, route, mode === 'demo'))
  const [demoPhone, setDemoPhone] = useState(true)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [calls, setCalls] = useState<Alert[]>([])
  const [keyIn, setKeyIn] = useState('')
  const [, force] = useState(0)
  const demoMode = mode === 'demo'
   useEffect(() => { setMsg(hindiAlert(v.name, r, route, mode === 'demo')); setReview(false) }, [r.id, mode, exercise]) // eslint-disable-line
   useEffect(() => { if (demoMode || exercise || !hasKey()) return; listContacts(v.lat, v.lng, 25).then(setContacts).catch(() => {}) }, [r.id, keyIn, demoMode, exercise]) // eslint-disable-line
   useEffect(() => {
      const incidentId = st?.incident?.id
      if (demoMode || !incidentId || !['calling', 'contacted', 'evacuating', 'resolved'].includes(st.stage)) return
      let active = true
      const load = () => listAlerts(incidentId).then(calls => { if (active) setCalls(calls) }).catch(() => {})
      load(); const id = setInterval(load, 10000); return () => { active = false; clearInterval(id) }
    }, [st?.incident?.id, st?.stage, demoMode])
  const maxPts = r.factors.reduce((a, f) => a + f.max, 0)
  const ctx = {
    place: `${v.name}, ${v.district || 'Bihar'}`, title: `Predicted flood: ${v.name} ${r.level}`, source: exercise ? (spreadUi?.source === 'live' ? 'JalNetra prediction (GloFAS river model + Open-Meteo rain + terrain)' : 'JalNetra prediction on the replayed September 2026 flood') : mode === 'demo' ? 'JalNetra prediction on replayed 2026 data (simulation)' : 'JalNetra prediction (GloFAS river model + Open-Meteo rain + terrain)',
    observed: fmtIST(run.now), safe_place: route ? `${route.shelter.n}, ${route.km.toFixed(1)} km away` : 'nearest high ground', village: v.name, risk: `${r.level} (${Math.round(r.pMax * 100)}% flood probability within 24 h)`,
    impact_time: r.impactH === null ? 'not within 48 hours' : r.impactH === 0 ? 'water predicted now' : `about ${r.impactH} hours (window ${windowText(r)})`,
    route: route ? `${route.km.toFixed(1)} km to ${route.shelter.n}, ${route.roadKm.toFixed(1)} km of it on roads. ${route.why}` : 'no dry shelter found within 30 km', model_updated: fmtIST(run.at), simulated: mode === 'demo' || exercise,
  }
  const approveExercise = async () => {
    setSt({ stage: 'approving', error: undefined })
    let key = '', requestId = '', horizon: Horizon = 6
    try {
      const session = await ensureExerciseSession()
      const a = session.alerts.find(x => x.prediction.villageId === r.id)
      if (!a) throw new Error('This village is not part of the exercise session.')
      key = approvalKey(session.id, a.id)
      horizon = (HORIZON_SET.includes(h) ? h : 6) as Horizon
      if (a.approvalStatus === 'approved') { setSt({ ...exerciseOutcome(a, session.demoDestination.masked), esc: { sessionId: session.id, alertId: a.id } }); return }
      const prior = readAttempt(key)
      if (prior && (prior.state === 'inflight' || prior.state === 'unknown')) throw new Error('An earlier approval of this alert was not confirmed. It will not be repeated; refresh to reconcile.')
      requestId = prior?.requestId ?? crypto.randomUUID()
      writeAttempt(key, { requestId, horizon, state: 'inflight' })
      setSt({ stage: 'calling' })
      const citizen = citizenAlert(v.name, v.district, r.impactH, route ? route.shelter.n : null, route ? route.km : null, false)
      const res = await approveAlert(session.id, a.id, requestId, horizon, { hi: msg, en: englishAlert(v.name, r, route, mode === 'demo') }, citizen)
      writeAttempt(key, { requestId, horizon, state: 'settled' })
      setSt({ ...exerciseOutcome(res.alert, session.demoDestination.masked), esc: { sessionId: session.id, alertId: a.id } })
    } catch (e) {
      if (requestId && key) { try { writeAttempt(key, { requestId, horizon, state: e instanceof DemoApiError && e.ambiguous ? 'unknown' : 'rejected' }) } catch { /* storage unavailable */ } }
      const message = (e as Error).message
      setSt({ stage: message.startsWith('Operator') || (e instanceof DemoApiError && e.code === 'KEY_REQUIRED') ? 'review' : 'error', error: message })
    }
  }
  const approve = async () => {
    if (exercise) { await approveExercise(); return }
    setSt({ stage: 'approving', error: undefined })
    if (demoMode) {
      // Replay is deliberately client-only: it must not create incidents or place calls.
       setSt({ stage: 'contacted', incident: undefined, approved: undefined, telephony: 'simulation', error: undefined })
      return
    }
    try {
      const why = r.factors.filter(f => f.pts >= 3).map(f => `${f.label}: ${f.detail}`).join('; ')
      const prediction = { level: r.level, p: Math.round(r.pMax * 100) / 100, impactH: r.impactH, window: r.window, score: r.score, conf: r.conf, action: r.action, why, factors: r.factors.map(f => ({ label: f.label, pts: Math.round(f.pts), detail: f.detail })), issued_for: new Date(run.now).toISOString(), model_version: run.version }
       const created = st?.incident ? { incident: st.incident } : await createIncident({ incident_type: 'river_flood', severity: 'high', source: 'forecast', status: 'alert_created', lat: v.lat, lng: v.lng, confidence: Math.min(1, r.pMax), title: `Predicted flood: ${v.name} ${r.level}, impact ${impactText(r)}`, details: { village: v.name, district: v.district, simulated: exercise, exercise, prediction, route: ctx.route } })
       setSt({ incident: created.incident, approved: st?.approved || incidentApproved(created.incident) })
       const inc = await approveIncident(created.incident, `Approved by operator after review. ${why}`)
       // Resolving approveIncident is the approval evidence, even when the API
       // returns the same status for an already-approved/merged incident.
       setSt({ stage: 'calling', incident: inc, approved: true })
      const res = await sendAlerts(inc.id, picked, msg, 'call', { demo: demoPhone, context: ctx as any })
      setSt({ stage: res.results.some(x => x.status === 'sent') ? 'contacted' : 'error', incident: { ...inc, status: res.status ?? inc.status }, telephony: res.telephony, error: res.results.some(x => x.status === 'sent') ? undefined : res.results.map(x => `${x.contact}: ${x.error ?? x.status}`).join('; ') || 'No recipients' })
    } catch (e) {
      const message = (e as Error).message
      // A rejected key should return to the key-entry gate rather than leave
      // the operator stuck in a failed approval state.
      setSt({ stage: message.startsWith('Operator key rejected') ? 'review' : 'error', error: message })
    }
  }
   const move = async (s: 'evacuating' | 'resolved') => { if (demoMode || exercise) { setSt({ stage: s, error: undefined }); return } if (!st?.incident) return; try { const u = await setStatus(st.incident.id, s, s === 'evacuating' ? 'Evacuation started after the call' : 'Village reported safe'); setSt({ stage: s, incident: u.incident, error: undefined }) } catch (e) { setSt({ error: (e as Error).message }) } }
   const stage = st?.stage ?? 'review'
   const simulatedApproval = demoMode && ['calling', 'contacted', 'evacuating', 'resolved'].includes(stage)
  return (
    <section className="vpanel">
      <div className="vhead"><div><div className="kicker">{v.district ? `${v.district} district` : 'Village'} · {v.ch.toFixed(0)} km below Devghat</div><div className="h big">{v.name}</div></div><button className="x" onClick={onClose} aria-label="Close"><FiX /></button></div>
      <div className="vp-sum">
        <div className="vp-tags"><span className={'pill lv-' + r.level}>{r.level} RISK</span>{(mode === 'demo' || exercise) && <span className="pill sim">{exercise ? 'EXERCISE' : 'SIMULATION'}</span>}</div>
        <div className="vp-kpis">
          <div><span>Flood chance</span><b>{Math.round(r.pMax * 100)}%</b></div>
          <div><span>Water arrives</span><b>{r.impactH === null ? 'Not in 48 h' : r.impactH === 0 ? 'Now' : `~${r.impactH} h`}</b></div>
        </div>
        <div className="vp-action">{r.action}</div>
      </div>
      <button className="whybtn" onClick={() => setWhy(w => !w)}>{why ? <FiChevronDown /> : <FiChevronRight />} Why is this village at risk?</button>
      {why && <div className="why">
        {r.factors.map(f => <div key={f.label} className="fac"><div className="fl"><span>{f.pts >= 3 ? '+ ' : ''}{f.label}</span><span className="dim">{Math.round(f.pts)}/{f.max}</span></div><div className="fb"><i style={{ width: `${(f.pts / f.max) * 100}%` }} /></div><div className="fd">{f.detail}</div></div>)}
        <div className="dim tiny">Risk score {r.score} of {maxPts}. CRITICAL needs ≥50% probability, score ≥65 and impact within 12 h. Probability comes from a logistic model fitted to 2026 radar; its terms (log-odds):</div>
        <ul className="terms">{r.terms.map(t => <li key={t.label}><span>{t.label}</span><span className={t.value >= 0 ? 'pos' : 'neg'}>{t.value >= 0 ? '+' : ''}{t.value.toFixed(2)}</span></li>)}</ul>
      </div>}
      {exercise && townInfo && spreadUi && <TownSpread name={v.name} f={townInfo} zone={zoneInfo ?? null} ui={spreadUi} onBroadcast={onBroadcast} />}
      <section className="vp-route">
        <h4>Safe route</h4>
        {route ? <>
          <p className="vp-dest"><b>{route.shelter.n}</b><span>{route.shelter.a === 'h' ? 'Hospital' : 'School / college'} · {route.km.toFixed(1)} km{realInfo?.drive ? ` · ${realInfo.drive.minutes} min by car` : ''}{realInfo?.walk ? ` · ${realInfo.walk.minutes} min on foot` : ''}</span></p>
          {!route.ok && <p className="vp-warn"><FiAlertTriangle /> No fully dry route. This is the least exposed one: leave before the water arrives.</p>}
          <button className="whybtn" onClick={() => setRouteMore(m => !m)}>{routeMore ? <FiChevronDown /> : <FiChevronRight />} Route details</button>
          {routeMore && <div className="why">
            <p className="note">{route.why}</p>
            <div className="route-legend note tight">
              <div><span style={{ color: '#12805c', fontWeight: 700 }}>━ By car</span>: {realInfo?.drive ? `${realInfo.drive.km.toFixed(1)} km, about ${realInfo.drive.minutes} min` : realInfo?.busy ? 'finding a road route…' : 'no driving route on the mapped roads'}{googleDrive ? ` · Google Maps: ${googleDrive.km.toFixed(1)} km, ${googleDrive.minutes} min` : ''}</div>
              <div><span style={{ color: '#1769e0', fontWeight: 700 }}>┅ On foot</span>: {realInfo?.walk ? `${realInfo.walk.km.toFixed(1)} km, about ${realInfo.walk.minutes} min` : realInfo?.busy ? 'finding a walking route…' : 'no walking route found'}</div>
            </div>
            <p className="note dim">Nearest mapped school, college or hospital outside predicted water (OpenStreetMap). Not a confirmed relief camp.</p>
          </div>}
        </> : <p className="note">No school or hospital that stays dry within 30 km without crossing a river.</p>}
      </section>

      {route && <RouteShare v={v} r={r} route={route} exercise={exercise} />}

      {/* ---- human in the loop ---- */}
      {(exercise || r.level === 'HIGH' || r.level === 'CRITICAL' || r.level === 'MEDIUM') && <div className="approve">
         <div className="kicker mt">{demoMode ? 'Simulated operator decision' : 'Operator decision'}</div>
         {demoMode && <p className="note">All steps below are simulated in this browser. No incidents are created, no calls are placed, and no notifications are sent.</p>}
         {stage === 'review' && !review && <div className="aqb"><button className="pri" onClick={() => setReview(true)}><FiPhoneCall /> {demoMode ? 'Review simulated alert' : 'Review and approve alert'}</button></div>}
        {stage === 'review' && review && <>
           <div className="whyalert"><div className="kicker">{demoMode ? 'Why this simulated alert is suggested' : 'Why this alert is suggested'}</div><ul className="reasons">{r.factors.filter(f => f.pts >= 3).map(f => <li key={f.label}><b>{f.label}</b>: {f.detail}</li>)}</ul></div>
          {mode !== 'demo' && !exercise && !hasKey() ? <><p className="note">Paste the operator key (TEAM_KEYS.txt) to approve and call.</p><input className="note-in" placeholder="jn_..." value={keyIn} onChange={e => setKeyIn(e.target.value)} /><div className="aqb"><button className="pri" disabled={!keyIn.trim()} onClick={() => { saveKey(keyIn); force(x => x + 1) }}>Connect</button></div></> : <>
             {!demoMode && !exercise && <><div className="kicker mt">Who gets the Hindi AI call</div>
            {contacts.length > 0 ? <ul className="clist">{contacts.map(c => <li key={c.id}><label><input type="checkbox" checked={picked.includes(c.id)} onChange={e => setPicked(p => e.target.checked ? [...p, c.id] : p.filter(x => x !== c.id))} /><span><b>{c.name}</b> · {c.role}, {c.place_name} <span className="imeta">{c.km?.toFixed(1)} km</span></span></label></li>)}</ul> : <p className="note tight">No sarpanch or NGO contact saved within 25 km yet (add them in Incidents).</p>}
             <label className="demo-row"><input type="checkbox" checked={demoPhone} onChange={e => setDemoPhone(e.target.checked)} /> <span>Call the demo phone</span></label></>}
             {demoMode && <div className="kicker mt">Simulated Hindi message preview</div>}
             {exercise && <div className="whyalert"><div className="kicker">Where this goes</div><p className="note tight">Exercise: the Hindi advisory is addressed to the village head and delivered to the configured demo phone only. The server allows one attempt per alert, a 30 s cooldown and 3 calls per session, and writes the final message.</p></div>}
            <textarea className="note-in msg" rows={6} value={msg} readOnly={exercise} onChange={e => setMsg(e.target.value)} />
             <p className="note tight">{demoMode ? 'Preview only: this message is not spoken or sent to anyone.' : 'The AI agent speaks this first, then answers questions such as "हमें कहाँ जाना चाहिए?" from this prediction: village, risk, impact time, shelter, route and model time.'}</p>
            <div className="aqb"><button className="pri" disabled={!demoMode && !exercise && !picked.length && !demoPhone} onClick={approve}><FiCheckCircle /> {demoMode ? 'Simulate approval and call' : exercise ? 'Approve exercise alert and call demo phone' : 'Approve alert and call'}</button><button className="ghost" onClick={() => setReview(false)}>Cancel</button>{exercise && <button className="ghost" onClick={() => { setSt({ stage: 'dismissed' }); onClose() }}>Reject</button>}</div>
          </>}
        </>}
         {exercise && st?.esc ? <EscalationTracker esc={st.esc} /> : (stage !== 'review' && stage !== 'dismissed' || !!st?.incident) && <ol className="steps">
           {[['Alert created', demoMode ? simulatedApproval : exercise ? !!st?.approved : !!st?.incident], ['Operator approved', demoMode ? simulatedApproval : !!st?.approved], ['Hindi AI call placed', ['contacted', 'evacuating', 'resolved'].includes(stage)], [exercise ? 'Village head reached (exercise: demo phone)' : 'Sarpanch contacted', ['contacted', 'evacuating', 'resolved'].includes(stage)], ['Evacuation initiated', ['evacuating', 'resolved'].includes(stage)], ['Resolved', stage === 'resolved']].map(([l, ok]) => <li key={l as string} className={ok ? 'ok' : ''}>{ok ? <FiCheckCircle /> : <span aria-label="Not completed">○</span>} {demoMode ? `Simulated: ${l}` : l}</li>)}
         </ol>}
         {stage === 'approving' && <p className="note"><FiRefreshCw className="spin" /> {demoMode ? 'Simulating alert creation and approval…' : 'Creating incident and recording approval…'}</p>}
         {stage === 'calling' && <p className="note"><FiRefreshCw className="spin" /> {demoMode ? 'Simulating a call…' : 'Placing the call…'}</p>}
        {exercise && st?.telephony && !st?.error && <p className="note">{st.telephony}</p>}
        {st?.error && <p className="err"><FiAlertTriangle /> {st.error}</p>}
         {!demoMode && calls.length > 0 && <ul className="tl">{calls.slice(0, 4).map(a => <li key={a.id}><b>{a.jn_contacts?.name ?? 'Demo phone'}: {a.status !== 'sent' ? a.status : a.call_status && a.call_status !== 'dispatched' ? a.call_status.replace('-', ' ') : 'ringing'}</b>{a.questions && a.questions.length > 0 && <div className="tlnote">Asked: {a.questions.join(' · ')}</div>}{a.summary && <div className="tlnote">{a.summary}</div>}</li>)}</ul>}
         {(demoMode || exercise || st?.incident) && <div className="aqb">
           {stage === 'contacted' && <button onClick={() => move('evacuating')}>{demoMode ? 'Simulate evacuation' : 'Evacuation started'}</button>}
           {(stage === 'contacted' || stage === 'evacuating') && <button className="ghost" onClick={() => move('resolved')}>{demoMode ? 'Simulate resolution' : 'Resolved'}</button>}
           {!demoMode && st?.incident?.id && <button className="ghost" onClick={() => onOpenIncident(st.incident!.id)}><FiExternalLink /> Open incident</button>}
        </div>}
      </div>}
    </section>
  )
}

type ZoneUi = { floodKm2: number; evacKm2: number; population: number | null; phones: number | null; loading: boolean; source: 'worldpop' | 'estimate'; error?: string; progress: number | null; icons: number }
type SpreadUi = { source: 'replay' | 'live'; setSource: (s: 'replay' | 'live') => void; liveOk: boolean; showFlood: boolean; setShowFlood: (v: boolean) => void; showEvac: boolean; setShowEvac: (v: boolean) => void; showPhones: boolean; setShowPhones: (v: boolean) => void }
function TownSpread({ name, f, zone, ui, onBroadcast }: { name: string; f: TownFacts; zone: ZoneUi | null; ui: SpreadUi; onBroadcast?: () => void }) {
  const [more, setMore] = useState(false)
  const hz = f.horizon === 0 ? 'now' : `+${f.horizon} h`
  const phones = zone?.phones ?? null
  const notified = phones !== null && zone?.progress != null ? Math.round(zone.progress * phones) : 0
  const done = (zone?.progress ?? 0) >= 1
  return (
    <section className="ts">
      <div className="ts-head"><h4>Flood impact zone</h4>
        <div className="ts-seg" role="group" aria-label="Data source">
          <button className={ui.source === 'replay' ? 'on' : ''} onClick={() => ui.setSource('replay')} title="September 2026 flood, replayed">Replay</button>
          <button className={ui.source === 'live' ? 'on' : ''} disabled={!ui.liveOk} title={ui.liveOk ? 'Live river forecast' : 'Live river feed is unavailable right now'} onClick={() => ui.setSource('live')}>Live</button>
        </div>
      </div>

      <div className="ts-chips" role="group" aria-label="Map layers">
        <button className={'chip flood' + (ui.showFlood ? ' on' : '')} aria-pressed={ui.showFlood} onClick={() => ui.setShowFlood(!ui.showFlood)}><i />Flood</button>
        <button className={'chip evac' + (ui.showEvac ? ' on' : '')} aria-pressed={ui.showEvac} onClick={() => ui.setShowEvac(!ui.showEvac)}><i />Evacuation zone</button>
        <button className={'chip phone' + (ui.showPhones && ui.showEvac ? ' on' : '')} aria-pressed={ui.showPhones && ui.showEvac} disabled={!ui.showEvac} onClick={() => ui.setShowPhones(!ui.showPhones)}><i />Phones</button>
      </div>

      <div className="ts-hero">
        <span>Phones in the evacuation zone</span>
        <b>{phones !== null ? `≈ ${phones.toLocaleString()}` : '—'}</b>
        <em>{zone?.population != null ? `≈ ${zone.population.toLocaleString()} people` : ''}{zone ? ` · ${zone.evacKm2.toLocaleString()} km²` : ''}</em>
      </div>

      {phones !== null && (zone?.progress == null
        ? <button className="pri ts-send" disabled={phones === 0} onClick={onBroadcast}><FiSend /> Send distress signal</button>
        : <div className="ts-prog" aria-live="polite"><div className="zone-bar"><i style={{ width: `${Math.round((zone?.progress ?? 0) * 100)}%` }} /></div>
          <span>{done ? <FiCheckCircle /> : <FiRefreshCw className="spin" />} <b>{notified.toLocaleString()}</b> of {phones.toLocaleString()} phones notified{done ? ' · complete' : '…'}</span></div>)}

      <div className="ts-mini">
        <div><span>Water reaches {name}</span><b>{f.arrivalH === null ? 'Not within 24 h' : f.arrivalH === 0 ? 'Now' : `~${f.arrivalH} h`}</b></div>
        <div><span>Flood at {hz}</span><b>{(zone?.floodKm2 ?? f.extraKm2).toLocaleString()} km²</b></div>
      </div>

      <p className="ts-note">Simulation only: no call or message is sent. In practice the zone goes out as one cell broadcast.</p>

      <button className="whybtn" onClick={() => setMore(m => !m)}>{more ? <FiChevronDown /> : <FiChevronRight />} Details and parameters</button>
      {more && <div className="why">
        <dl className="kv small">
          <dt>Data</dt><dd>{ui.source === 'replay' ? `Replay of the Sept 2026 flood (${fmtIST(Date.parse(SPREAD_CLOCK))})` : 'Live GloFAS + rain forecast'}</dd>
          <dt>Population</dt><dd>{zone?.source === 'worldpop' ? 'WorldPop 2020, live' : `Density estimate, about ${FALLBACK_DENSITY_PER_KM2}/km² (WorldPop slow or unavailable)`}</dd>
          <dt>Land within 2 km</dt><dd>{Math.round(f.share2km * 100)}% under predicted water</dd>
          <dt>Nearest water</dt><dd>{f.waterKm === null ? 'None in the reach' : `${f.waterKm.toFixed(1)} km`}</dd>
          <dt>Highest ground</dt><dd>{f.maxHandM === null ? '—' : `${f.maxHandM.toFixed(1)} m above channel`}</dd>
          {f.horizon > 0 && <><dt>Growth since NOW</dt><dd>+{f.growthKm2.toLocaleString()} km²</dd></>}
        </dl>
        <dl className="param-grid">
          <dt>Flood probability</dt><dd>logistic({M.pixel.b0.toFixed(2)} + {M.pixel.b[0].toFixed(2)}·ln(Q/4000) {M.pixel.b[1].toFixed(2)}·HAND {M.pixel.b[2].toFixed(2)}·dist), wet if ≥ {M.pixel.pstar}</dd>
          <dt>Inputs</dt><dd>GloFAS discharge (72 h high), Copernicus DEM height above channel, distance to river, JRC normal river</dd>
          <dt>Flood polygon</dt><dd>Connected flooded cells within ±{REACH_HALF_KM} km of the village along the river</dd>
          <dt>Evacuation zone</dt><dd>Flood now and at the next step, plus {(EVAC_BUFFER_CELLS * 0.2).toFixed(1)} km margin</dd>
          <dt>Phones</dt><dd>Population × {PHONES_PER_PERSON} (assumption); up to {zone?.icons ?? 0} icons, positions illustrative</dd>
          <dt>Calibration</dt><dd>3 Sentinel-1 radar flood maps, Sep–Oct 2026</dd>
        </dl>
      </div>}
    </section>
  )
}

function EscalationTracker({ esc }: { esc: { sessionId: string; alertId: string } }) {
  const [v, setV] = useState<EscalationView | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState(false)
  const [, tick] = useState(0)
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined
    const done = new Set(['escalated', 'rejected', 'expired', 'failed'])
    const load = async () => {
      try {
        const x = await getEscalation(esc.sessionId, esc.alertId)
        if (!alive) return
        setV(x); setErr(null)
        if (x && done.has(x.status) && x.citizen.call?.status !== undefined) return
      } catch (e) { if (alive) setErr((e as Error).message) }
      timer = setTimeout(load, 1500)
    }
    void load()
    const clock = setInterval(() => tick(n => n + 1), 1000)
    return () => { alive = false; if (timer) clearTimeout(timer); clearInterval(clock) }
  }, [esc.sessionId, esc.alertId])

  if (!v) return <div className="esc"><div className="kicker mt">Live escalation</div><p className="note">{err ?? 'Opening the escalation…'}</p></div>
  const left = Math.max(0, Math.round((Date.parse(v.expiresAt) - Date.now()) / 1000))
  const waiting = v.status === 'awaiting_sarpanch'
  const escalated = v.status === 'escalated' || v.status === 'escalating'
  const banner = escalated
    ? { cls: 'go', icon: <FiCheckCircle />, title: 'ESCALATED', text: `Sarpanch confirmed${v.decidedVia ? ` via ${v.decidedVia}` : ''}. ${v.citizen.call?.status === 'sent' ? 'Citizens in the zone are being called.' : v.status === 'escalating' ? 'Calling the citizens…' : 'Citizen call: ' + (v.citizen.call?.status ?? 'pending')}` }
    : v.status === 'rejected' ? { cls: 'no', icon: <FiX />, title: 'REJECTED: FALSE ALARM', text: `Sarpanch rejected${v.decidedVia ? ` via ${v.decidedVia}` : ''}. Nobody else is contacted.` }
    : v.status === 'expired' ? { cls: 'no', icon: <FiAlertTriangle />, title: 'EXPIRED', text: 'No decision in time. Nothing was escalated.' }
    : v.status === 'failed' ? { cls: 'no', icon: <FiAlertTriangle />, title: 'ESCALATION FAILED', text: v.citizen.call?.note ?? 'The citizen call could not be placed.' }
    : { cls: 'wait', icon: <FiRefreshCw className="spin" />, title: 'WAITING FOR THE SARPANCH', text: `${v.acknowledged ? 'The Sarpanch heard the full message. ' : ''}Answer on the call (say one / yes, or zero / no) or on Telegram. Expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.` }
  const rows: { label: string; state: 'ok' | 'wait' | 'no' | 'idle'; detail?: string }[] = [
    { label: 'Operator approved the alert', state: 'ok' },
    { label: `Sarpanch called${v.sarpanch.phone ? ` (${v.sarpanch.phone})` : ''}`, state: v.sarpanch.call.status === 'dispatched' ? 'ok' : 'no', detail: 'Two-way IVR: reads the advisory, then listens for one / zero / two or yes / no.' },
    waiting ? { label: v.acknowledged ? 'Sarpanch heard the message, no decision yet' : 'Waiting for the Sarpanch to decide', state: 'wait', detail: v.channels.telegram ? 'Call answer or Telegram buttons: whichever comes first.' : 'Telegram is not configured.' }
      : v.status === 'rejected' ? { label: 'Sarpanch rejected: false alarm', state: 'no', detail: `Via ${v.decidedVia ?? 'reply'}.` }
      : v.status === 'expired' ? { label: 'No decision in time', state: 'no' }
      : { label: 'Sarpanch confirmed the alert', state: 'ok', detail: `Via ${v.decidedVia ?? 'reply'}.` },
    { label: `Citizens in the zone called${v.citizen.phone ? ` (${v.citizen.phone})` : ''}`, state: escalated || v.status === 'failed' ? (v.citizen.call?.status === 'sent' ? 'ok' : v.status === 'escalating' ? 'wait' : 'no') : 'idle', detail: escalated ? (v.citizen.call?.status === 'sent' ? 'One urgent line, male voice. Dispatched, not confirmed answered.' : v.citizen.call?.note ?? '') : 'Only after the Sarpanch confirms.' },
  ]
  return (
    <div className="esc" aria-live="polite">
      <div className="kicker mt">Live escalation · Sarpanch → citizens</div>
      <div className={'esc-banner ' + banner.cls}><span className="ic">{banner.icon}</span><div><b>{banner.title}</b><small>{banner.text}</small></div></div>
      <ol className="esc-steps">
        {rows.map(r => <li key={r.label} className={r.state}><span className="dot">{r.state === 'ok' ? <FiCheckCircle /> : r.state === 'wait' ? <FiRefreshCw className="spin" /> : r.state === 'no' ? <FiX /> : '○'}</span><div><b>{r.label}</b>{r.detail && <small>{r.detail}</small>}</div></li>)}
      </ol>
      <div className="kicker mt">Live log</div>
      <ul className="esc-log">
        {[...v.events].reverse().map((e, i) => <li key={i} className={e.kind}><time>{new Date(e.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata' })}</time><span>{e.text}</span></li>)}
      </ul>
      {v.citizenMessage.en && <><button className="whybtn" onClick={() => setMsg(m => !m)}>{msg ? <FiChevronDown /> : <FiChevronRight />} Message citizens will hear</button>
        {msg && <div className="why"><p className="note">{v.citizenMessage.hi}</p><p className="note dim">{v.citizenMessage.en}</p></div>}</>}
      {err && <p className="err"><FiAlertTriangle /> {err}</p>}
    </div>
  )
}

function RouteShare({ v, r, route, exercise }: { v: { name: string; district?: string; lat: number; lng: number }; r: VillageRisk; route: Route; exercise: boolean }) {
  const [copied, setCopied] = useState(false)
  const [audio, setAudio] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [draftErr, setDraftErr] = useState('')
  const [walk, setWalk] = useState<Walk | null>(null)
  const [walkErr, setWalkErr] = useState('')
  const [walkBusy, setWalkBusy] = useState(false)
  const [tg, setTg] = useState<'idle' | 'sending' | 'sent' | 'failed'>('idle')
  const [tgErr, setTgErr] = useState('')
  const shared: SharedRoute = useMemo(() => ({
    v: v.name, d: v.district || undefined, lvl: r.level, when: r.impactH === null ? '' : windowText(r), at: new Date().toISOString(),
    from: [v.lat, v.lng], to: [route.shelter.y, route.shelter.x], shelter: route.shelter.n, km: route.km, path: simplify(route.path, 40), ex: exercise || undefined,
  }), [v.name, v.district, v.lat, v.lng, r.level, r.impactH, route, exercise])
  const link = `${location.origin}/route?d=${encodeRoute(shared)}`
  useEffect(() => {
    setWalk(null); setWalkErr(''); setDraft(null); setAudio(''); setWalkBusy(true)
    walkingRoute(shared.from, shared.to).then(setWalk).catch(e => setWalkErr((e as Error).message)).finally(() => setWalkBusy(false))
  }, [shared.from[0], shared.from[1], shared.to[0], shared.to[1]]) // eslint-disable-line react-hooks/exhaustive-deps
  const runDraft = async () => {
    setDrafting(true); setDraftErr('')
    try { setDraft(await draftAdvisory({ village: shared.v, district: shared.d, risk: shared.lvl, impact: shared.when, shelter: shared.shelter, km: shared.km.toFixed(1), exercise: !!shared.ex })) }
    catch (e) { setDraftErr((e as Error).message) } finally { setDrafting(false) }
  }
  const voiceText = draft?.hi || hindiRouteLine(shared)
  const sendTelegram = async () => {
    setTg('sending'); setTgErr('')
    try {
      const [web, ar, base] = await Promise.all([shortRouteLink(shared), shortRouteLink(shared, true), publicBase()])
      const sim = exercise
      const text = [
        sim ? '🟡 JALNETRA · EXERCISE ALERT (अभ्यास, not a real warning)' : '🔴 JALNETRA · FLOOD ALERT',
        '',
        `📍 ${v.name}${v.district ? `, ${v.district}` : ''}`,
        `⚠️ Risk: ${r.level}${shared.when ? ` · water ${shared.when}` : ''}`,
        `🏫 Safe place: ${route.shelter.n} (${route.km.toFixed(1)} km)`,
        `🛣 ${route.ok ? 'Route avoids likely flood water' : 'Least-exposed route: leave before the water arrives'} · ${route.roadKm.toFixed(1)} km on mapped roads`,
        '',
        hindiAlert(v.name, r, route, sim),
        '',
        englishAlert(v.name, r, route, sim),
        '',
        ...(audio ? [`🔊 सुनें / Listen: ${audio.startsWith('/') ? base + audio : audio}`] : []),
        `🧭 3D route: ${web}`,
        `📱 AR arrow (open on phone): ${ar}`,
        `🗺 Google Maps: ${mapsLink(shared)}`,
      ].join('\n')
      const res = await fetch('/local-api/telegram', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
      const b = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(b.error || `Telegram request failed (${res.status})`)
      setTg('sent')
    } catch (e) { setTg('failed'); setTgErr((e as Error).message) }
  }
  const copy = async () => { try { await navigator.clipboard.writeText(`${shareText(shared)} ${link}`); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch { /* clipboard unavailable */ } }
  return (
    <div className="route-share">
      <div className="kicker mt">Send the route to the village head</div>
      <button className="share-primary" onClick={() => void sendTelegram()} disabled={tg === 'sending'}><FiSend /> {tg === 'sending' ? 'Sending…' : tg === 'sent' ? 'Sent on Telegram ✓' : 'Send on Telegram'}</button>
      <p className="share-hint">Sends the village, risk, safe place and a link that opens the route (and AR on a phone).</p>
      <div className="share-grid">
        <a href={link} target="_blank" rel="noreferrer"><FiCamera /> Open route</a>
        <a href={mapsLink(shared)} target="_blank" rel="noreferrer"><FiExternalLink /> Google Maps</a>
        <button onClick={() => void copy()}><FiCopy /> {copied ? 'Copied' : 'Copy'}</button>
      </div>
      <div className="share-row">
        <span className="rc-label">Listen</span>
        <div className="seg-group">
          <ListenButton text={voiceText} onUrl={setAudio} short className="seg-btn" />
          <ListenButton text={draft?.en || englishAlert(shared.v, r, route, !!shared.ex)} lang="en" short className="seg-btn" />
        </div>
        <button className="btn-ghost" onClick={() => void runDraft()} disabled={drafting}>{drafting ? 'Drafting…' : 'Draft advisory'}</button>
      </div>
      {tgErr && <p className="err"><FiAlertTriangle /> {tgErr}</p>}
      {draftErr && <p className="err"><FiAlertTriangle /> {draftErr}</p>}
      {draft && <div className="draft"><div className="kicker">Advisory draft · review before use</div>{draft.hi && <p lang="hi">{draft.hi}</p>}<p lang="en">{draft.en}</p>{!draft.drafted && <small>The model was unavailable; this is a plain template.</small>}</div>}
      <WalkSteps walk={walk} loading={walkBusy} error={walkErr} />
    </div>
  )
}

function MonitorStatus() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null)
  useEffect(() => { if (!hasKey()) return; const load = () => listRuns().then(setRuns).catch(() => {}); load(); const id = setInterval(load, 60000); return () => clearInterval(id) }, [])
  if (!runs?.length) return <p className="note">Server monitor: runs every 15 minutes on the backend and opens alerts for HIGH or CRITICAL villages (operator key needed to see its log).</p>
  const r = runs[0]
  return <p className="note">Server monitor (every 15 min): last run {fmtIST(r.created_at)}, {r.error ? `failed: ${r.error}` : `${r.overall} overall, ${r.at_risk} villages at risk, ${r.alerts_created} new alert${r.alerts_created === 1 ? '' : 's'}`}. {runs.length} runs logged.</p>
}
