import { useEffect, useMemo, useState } from 'react'
import DeckGL from '@deck.gl/react'
import { MapView, type MapViewState } from '@deck.gl/core'
import { BitmapLayer, GeoJsonLayer, PathLayer, ScatterplotLayer } from '@deck.gl/layers'
import { TileLayer } from '@deck.gl/geo-layers'
import { AppBrand } from '../components/AppBrand'
import { FiActivity } from 'react-icons/fi'
import D from '../data.json'
import o1 from '../img/o1.png'
import o2 from '../img/o2.png'
import o3 from '../img/o3.png'
import countries from '../countries.json'
import { eventInputs, forecast, qEff, villageP } from '../engine/core'
import { bounds, extentAt, loadTerrain, type Terrain } from '../engine/terrain'
import { M, VILLAGES, fmtIST, fmtQ } from './shared'

const IMG: Record<string, string> = { o1, o2, o3 }
const KEYS = ['o1', 'o2', 'o3'] as const
const OBS = Object.fromEntries((D.obs as any[]).map(o => [o.id, o]))
const VOBS = new Map(D.villages.map(v => [v.id, v.obs as Record<string, number | null>]))
const VIEWS = [new MapView({ id: 'L', x: 0, width: '50%', controller: true }), new MapView({ id: 'R', x: '50%', width: '50%', controller: true })]
const INITIAL: MapViewState = { longitude: 84.75, latitude: 26.3, zoom: 7.5, pitch: 0, bearing: 0, minZoom: 4, maxZoom: 14 }

export default function Validate({ onBack, onLive, onStory }: { onBack: () => void; onLive: () => void; onStory: () => void }) {
  const [k, setK] = useState<(typeof KEYS)[number]>('o2')
  const lead = 24 as 0 | 24 // the back-test always uses the forecast issued 24 h before the radar pass
  const [view, setView] = useState<MapViewState>(INITIAL)
  const [T, setT] = useState<Terrain | null>(null)
  useEffect(() => { loadTerrain(M).then(setT) }, [])
  const tObs = Date.parse(M.obsTimes[k])
  const res = useMemo(() => {
    const F = forecast(M, eventInputs(M, tObs - lead * 3600e3, 'replay'))
    const coef = M.village.loo[k]
    const rows = VILLAGES.map(v => {
      const o = VOBS.get(v.id)![k], p = villageP(coef, v, qEff(F, v.ch, lead))
      return { v, valid: o !== null && o !== undefined, obs: o !== null && o !== undefined && o <= 0.5, pred: p >= M.village.warn, p }
    })
    const val = rows.filter(r => r.valid)
    const pred = val.filter(r => r.pred).length, obs = val.filter(r => r.obs).length, both = val.filter(r => r.pred && r.obs).length
    // ranking skill: the chance that a village that flooded was given a higher probability than one that did not (0.5 = coin flip, 1 = perfect)
    const pos = val.filter(r => r.obs), neg = val.filter(r => !r.obs)
    let w = 0
    for (const a of pos) for (const b of neg) w += a.p > b.p ? 1 : a.p === b.p ? 0.5 : 0
    const auc = pos.length && neg.length ? w / (pos.length * neg.length) : null
    return { F, rows, n: val.length, pred, obs, both, chance: val.length ? (pred * obs) / val.length : 0, prec: pred ? both / pred : null, rec: obs ? both / obs : null, auc }
  }, [k, lead, tObs])
  const ext = useMemo(() => {
    if (!T) return null
    const e = extentAt(M, T, res.F, lead, 'predicted')
    const c = document.createElement('canvas'); c.width = e.image!.width; c.height = e.image!.height; c.getContext('2d')!.putImageData(e.image!, 0, 0)
    return { canvas: c, km2: e.km2 }
  }, [T, res, lead])
  // 24 h-ahead forecast skill at three points across the event
  const skill = useMemo(() => {
    const t0 = Date.parse(M.event.start + 'T12:00:00Z'), pts: { t: number; f: number[]; a: number[] }[] = []
    for (let t = Date.parse('2026-09-24T00:00:00Z'); t <= Date.parse('2026-10-04T00:00:00Z'); t += 12 * 3600e3) {
      const F = forecast(M, eventInputs(M, t - 24 * 3600e3, 'replay'))
      const actual = [1, 3, 6].map(i => { const d = (t - t0) / 864e5, j = Math.floor(d), f = d - j, q = M.event.q[i]; return q[j] * (1 - f) + q[j + 1] * f })
      pts.push({ t, f: [1, 3, 6].map(i => F[i].q[72 + 24]), a: actual })
    }
    return pts
  }, [])
  const mae = [0, 1, 2].map(j => Math.round(skill.reduce((a, p) => a + Math.abs(p.f[j] - p.a[j]) / p.a[j], 0) / skill.length * 100))

  const base = (sfx: string) => [new TileLayer({ id: sfx + '-base', data: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', minZoom: 0, maxZoom: 17, tileSize: 256, renderSubLayers: (p: any) => { const b = p.tile.boundingBox; return new BitmapLayer(p, { data: undefined, image: p.data, bounds: [b[0][0], b[0][1], b[1][0], b[1][1]] }) } }), new GeoJsonLayer({ id: sfx + '-c', data: countries as any, filled: false, stroked: true, getLineColor: [255, 255, 255, 90], lineWidthMinPixels: 1 }), new PathLayer({ id: sfx + '-g', data: [{ path: D.river.path }], getPath: (d: any) => d.path, getColor: [186, 230, 253, 190], widthUnits: 'pixels', getWidth: 2 })]
  const dots = (field: 'pred' | 'obs', rgb: [number, number, number]) => new ScatterplotLayer({ id: (field === 'pred' ? 'L' : 'R') + '-v', data: res.rows.filter(r => r.valid), getPosition: (r: any) => [r.v.lng, r.v.lat], radiusUnits: 'pixels', getRadius: (r: any) => (r[field] ? 5 : 2.5), getFillColor: (r: any) => (r[field] ? [...rgb, 240] : [100, 116, 139, 200]) as any, stroked: true, getLineColor: [8, 10, 14], lineWidthMinPixels: 1, updateTriggers: { getRadius: [k, lead], getFillColor: [k, lead] } })
  const left = [...base('L'), ...(ext && T ? [new BitmapLayer({ id: 'L-pred' + k + lead, image: ext.canvas, bounds: bounds(T) })] : []), dots('pred', [34, 211, 238])]
  const right = [...base('R'), new BitmapLayer({ id: 'R-obs' + k, image: IMG[k], bounds: D.bounds as any, tintColor: [90, 140, 255] }), dots('obs', [96, 165, 250])]
  const o = OBS[k]
  return (
    <div className="app validate">
      <header className="vbar">
        <AppBrand onClick={onBack} />
        <div className="lb-brand"><div className="eyebrow">Back-test on the September 2026 flood · real data, not live</div><div className="title">Would JalNetra have warned in time?</div></div>
        <span className="map-spacer" />
        <div className="seg" aria-label="Satellite pass to compare">{KEYS.map(x => <button key={x} className={k === x ? 'on' : ''} onClick={() => setK(x)}>Satellite pass {new Date(M.obsTimes[x]).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</button>)}</div>
        <button className="storybtn" onClick={onStory}>Replay the story</button>
        <button className="storybtn" onClick={onLive}><FiActivity /> Live prediction</button>
      </header>
      <section className="validate-guide" aria-label="How to read this page">
        <div><b>Left: what JalNetra predicted</b>The forecast JalNetra would have issued 24 hours before the satellite pass, using only river data available at that time.</div>
        <div><b>Right: what actually happened</b>New water seen by Sentinel-1 radar on the date you pick above. This is observed, not modelled.</div>
        <div><b>Dots: villages</b>A bright dot is a village flagged (left) or flooded (right). Grey dots are villages that were not flagged or flooded.</div>
      </section>
      <p className="verdict">{res.n === 0 ? 'The radar did not cover any tracked village on this date, so there is nothing to compare.' : <>On {new Date(M.obsTimes[k]).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}, with the forecast made 24 hours earlier, JalNetra flagged <b>{res.pred}</b> villages. Radar later saw <b>{res.obs}</b> flooded: JalNetra caught <b>{res.both}</b>, missed <b>{res.obs - res.both}</b>, and raised <b>{res.pred - res.both}</b> false alarm{res.pred - res.both === 1 ? '' : 's'}.</>}</p>
      <div className="split">
        <DeckGL views={VIEWS} viewState={{ L: view, R: view } as any} onViewStateChange={(e: any) => setView(e.viewState)} layers={[...left, ...right]} layerFilter={({ layer, viewport }: any) => layer.id.startsWith(viewport.id + '-')} />
        <div className="half"><div className="htag hpred">JALNETRA PREDICTION<span>{lead ? `issued ${fmtIST(tObs - 24 * 3600e3)}, for +24 h` : `at ${fmtIST(tObs)}`}{ext ? ` · ${ext.km2.toLocaleString()} km²` : ''}</span></div></div>
        <div className="half r"><div className="htag hobs">SATELLITE OBSERVATION<span>Sentinel-1 radar, {fmtIST(tObs)} · {o.km2} km² new water · {Math.round(o.coverage * 100)}% of the map covered</span></div></div>
      </div>
      <footer className="vfoot">
        <div className="vnums">
          <div><span>Flagged by JalNetra</span><b>{res.pred}</b></div>
          <div><span>Flooded (seen by radar)</span><b>{res.obs}</b></div>
          <div><span>Correctly flagged</span><b className="ok">{res.both}</b></div>
          <div><span>Missed</span><b>{res.obs - res.both}</b></div>
          <div><span>False alarms</span><b>{res.pred - res.both}</b></div>
          <div><span>Would be right by luck</span><b className="dim">{res.chance.toFixed(0)}</b></div>
          <div><span>Of flooded villages, caught</span><b>{res.rec === null ? '–' : Math.round(res.rec * 100) + '%'}</b></div>
          <div><span>Of flagged, really flooded</span><b>{res.prec === null ? '–' : Math.round(res.prec * 100) + '%'}</b></div>
          <div><span>Ranking skill (0.5 = chance)</span><b>{res.auc === null ? '–' : res.auc.toFixed(2)}</b></div>
        </div>
        <p className="method"><b>How to read the numbers.</b> "Caught" is how many of the villages the radar saw flooded were flagged in advance (an early warning should make this high). "Really flooded" is how many flagged villages the radar confirmed. The warning line is set at {Math.round(M.village.warn * 100)}% probability, chosen to catch more floods at the cost of some false alarms. Radar only sees open water: flooding under trees, in towns and from local rain is missed, so "false alarms" are partly places the radar could not see. <br /><b>Method.</b> {res.n} villages had radar coverage on this date. Observed affected = Sentinel-1 saw new water within 500 m of the village. Predicted = the village model gives ≥{Math.round(M.village.warn * 100)}% flood probability, using only river data available {lead ? '24 h before the pass (the engine forecast the flow forward)' : 'at the pass'}. The village model was refitted without this date (leave-one-date-out), so it never saw the answer. "Expected by chance" = how many a random pick of the same size would get right. With only three radar dates this is a sanity check, not an accuracy score.</p>
        <div className="skill">
          <div className="kicker">24 h river forecast vs what happened (GloFAS)</div>
          <SkillChart pts={skill} />
          <div className="dim tiny">Mean error of the 24 h forecast: Valmikinagar {mae[0]}%, Dumariaghat {mae[1]}%, Hajipur {mae[2]}%, over {skill.length} forecasts from 24 Sep to 4 Oct. Peak flows: {fmtQ(Math.max(...M.event.q[1]))}, {fmtQ(Math.max(...M.event.q[3]))}, {fmtQ(Math.max(...M.event.q[6]))} m³/s.</div>
        </div>
      </footer>
    </div>
  )
}

function SkillChart({ pts }: { pts: { t: number; f: number[]; a: number[] }[] }) {
  const w = 520, h = 90, all = pts.flatMap(p => [...p.f, ...p.a]), mx = Math.max(...all) * 1.05, mn = Math.min(...all) * 0.95
  const X = (i: number) => 4 + (i / (pts.length - 1)) * (w - 8), Y = (v: number) => 4 + (1 - (v - mn) / (mx - mn)) * (h - 16)
  const line = (j: number, key: 'f' | 'a') => pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(p[key][j]).toFixed(1)}`).join('')
  const C = ['#93c5fd', '#fbbf24', '#f9a8d4']
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="spark" role="img" aria-label="24 hour forecast versus actual flow">
      {[0, 1, 2].map(j => <g key={j}><path d={line(j, 'a')} fill="none" stroke={C[j]} strokeWidth="1.6" /><path d={line(j, 'f')} fill="none" stroke={C[j]} strokeWidth="1.4" strokeDasharray="4 3" opacity=".9" /></g>)}
      <text x="4" y={h - 2} fontSize="9" fill="#66727f">24 Sep</text><text x={w - 4} y={h - 2} fontSize="9" fill="#66727f" textAnchor="end">4 Oct · solid = actual, dashed = forecast made 24 h earlier</text>
    </svg>
  )
}
