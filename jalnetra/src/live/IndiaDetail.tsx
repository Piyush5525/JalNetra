import { useEffect, useMemo, useState } from 'react'
import { FiAlertTriangle, FiCopy, FiMapPin, FiRefreshCw, FiX } from 'react-icons/fi'
import { villagesAtRisk, type PointStatus, type RiverPoint, type Status, type Village } from '../engine/india'
import { fmtQ } from './shared'
import { pointSeries, requestJson } from './riverWatchData'
import { AnimatedTabs } from '../components/ui/animated-tabs'
import { CardSpotlight } from '../components/ui/card-spotlight'

const WORD: Record<Status, string> = { NORMAL: 'Normal', RISING: 'Rising fast', WARNING: 'High', DANGER: 'Above the 2025 peak' }
const TONE: Record<Status, string> = { NORMAL: 'ok', RISING: 'rise', WARNING: 'warn', DANGER: 'danger' }
type Tab = 'overview' | 'forecast' | 'villages'

let villageCache: Promise<Village[]> | null = null
const loadVillages = () => (villageCache ??= requestJson('/india/villages.json').then(v => {
  if (!Array.isArray(v)) throw new Error('Invalid village list')
  return v as Village[]
}).catch(e => { villageCache = null; throw e }))

const dayWord = (k: number) => (k === 0 ? 'today' : k === 1 ? 'tomorrow' : `in ${k} days`)
const deg = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(3)}° ${v >= 0 ? pos : neg}`

function Chart({ s, p }: { s: PointStatus; p: RiverPoint }) {
  const w = 320, h = 132, vals = s.series.filter(Number.isFinite)
  if (vals.length < 2) return <p className="note">No forecast series for this point.</p>
  const mx = Math.max(...vals, p.max) * 1.08, X = (i: number) => 6 + (i / (s.series.length - 1)) * (w - 12), Y = (v: number) => 8 + (1 - v / mx) * (h - 30)
  const d = s.series.map((v, i) => (Number.isFinite(v) ? `${i && Number.isFinite(s.series[i - 1]) ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}` : '')).join('')
  const area = `${d}L${X(s.series.length - 1).toFixed(1)},${Y(0)}L${X(0).toFixed(1)},${Y(0)}Z`
  const guide = (v: number, c: string, t: string, below = false) => <g><line x1="6" x2={w - 6} y1={Y(v)} y2={Y(v)} stroke={c} strokeDasharray="3 3" /><text x={w - 6} y={Y(v) + (below ? 11 : -3)} fontSize="9.5" fill={c} textAnchor="end">{t}</text></g>
  const fmt = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  const todayX = X(s.today)
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="spark" role="img" aria-label={`River flow near ${p.near}: past and forecast`}>
      <defs><linearGradient id="fa" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#1b7a5a" stopOpacity=".28" /><stop offset="1" stopColor="#1b7a5a" stopOpacity="0" /></linearGradient></defs>
      <rect x={todayX} y="4" width={w - 6 - todayX} height={h - 26} fill="#0f4a38" opacity=".05" />
      {guide(p.max, '#a3241a', '2025 monsoon highest')}{p.p90 < p.max * 0.97 && guide(p.p90, '#b7791f', 'high monsoon day', true)}
      <path d={area} fill="url(#fa)" />
      <path d={d} fill="none" stroke="#0f4a38" strokeWidth="2.2" strokeLinejoin="round" />
      <line x1={todayX} x2={todayX} y1="4" y2={h - 22} stroke="#0d1912" strokeOpacity=".4" />
      <text x={todayX + 4} y={h - 24} fontSize="9.5" fill="#4f5d55">today</text>
      <text x="6" y={h - 6} fontSize="9.5" fill="#7c887f">{fmt(s.days[0])}</text>
      <text x={w - 6} y={h - 6} fontSize="9.5" fill="#7c887f" textAnchor="end">{fmt(s.days[s.days.length - 1])} · m³/s</text>
    </svg>
  )
}

function Stat({ label, value, unit, note, tone, wide }: { label: string; value: string; unit?: string; note?: string; tone?: string; wide?: boolean }) {
  return (
    <CardSpotlight className={`stat${wide ? ' wide' : ''}${tone ? ' ' + tone : ''}`}>
      <span className="stat-l">{label}</span>
      <span className="stat-v">{value}{unit && <small>{unit}</small>}</span>
      {note && <span className="stat-n">{note}</span>}
    </CardSpotlight>
  )
}

/** Full detail for one river point on the live map. */
export function IndiaDetail({ p, s, onClose }: { p: RiverPoint; s?: PointStatus; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('overview')
  const [detail, setDetail] = useState<PointStatus | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [villages, setVillages] = useState<Village[] | null>(null)
  const [vErr, setVErr] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setTab('overview'); setDetail(null); setErr(''); setBusy(true)
    const c = new AbortController()
    pointSeries(p, c.signal).then(d => { if (!c.signal.aborted) setDetail(d) }).catch(e => { if (!c.signal.aborted) setErr((e as Error).message) }).finally(() => { if (!c.signal.aborted) setBusy(false) })
    return () => c.abort()
  }, [p.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { loadVillages().then(setVillages).catch(e => setVErr((e as Error).message)) }, [])

  const cur = detail ?? s
  const here = useMemo(() => (villages ?? []).filter(v => v.p === p.id), [villages, p.id])
  const atRisk = useMemo(() => (cur ? villagesAtRisk(cur, here) : []), [cur, here])
  const status = cur?.status
  const high = status === 'WARNING' || status === 'DANGER'
  const why = !cur ? '' : cur.status === 'NORMAL'
    ? 'Flow is within this river\'s usual range for the next 7 days.'
    : cur.status === 'RISING'
      ? `Flow rises from ${fmtQ(cur.now)} to ${fmtQ(cur.peak)} m³/s ${dayWord(cur.peakDay)}. That is still below a high monsoon day for this river.`
      : cur.status === 'WARNING'
        ? `The forecast peak is above this river's high monsoon days (the top 10% of its 2025 monsoon).`
        : `The forecast peak is above anything this river reached in the 2025 monsoon.`
  const coords = `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`
  const copy = async () => { try { await navigator.clipboard.writeText(coords); setCopied(true); setTimeout(() => setCopied(false), 1600) } catch { /* clipboard unavailable */ } }

  return (
    <div className="india-detail">
      <div className="vhead">
        <div>
          <div className="kicker">{p.state || 'River point'}</div>
          <div className="h big">{p.river}</div>
          <div className="india-near"><FiMapPin /> near {p.near}</div>
        </div>
        <button className="x" onClick={onClose} aria-label="Back to all rivers"><FiX /></button>
      </div>
      {status && cur && <div className={`india-chip ${TONE[status]}`}><i />{WORD[status]} · {cur.trend}</div>}
      <AnimatedTabs<Tab> className="india-tabs" value={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Overview' }, { id: 'forecast', label: 'Forecast' }, { id: 'villages', label: high ? `Villages ${villages ? atRisk.length : ''}`.trim() : 'Villages' }]} />

      {tab === 'overview' && <div className="stat-grid">
        {cur ? <>
          <Stat label="Flow now" value={fmtQ(cur.now)} unit="m³/s" />
          <Stat label="Forecast peak" value={fmtQ(cur.peak)} unit="m³/s" note={dayWord(cur.peakDay)} tone={status ? TONE[status] : undefined} />
          <Stat label="High monsoon day" value={fmtQ(p.p90)} unit="m³/s" note="top 10% of 2025" />
          <Stat label="Highest in 2025" value={fmtQ(p.max)} unit="m³/s" />
        </> : <p className="note stat wide">{busy ? 'Loading…' : 'No validated discharge data is available for this point.'}</p>}
        <CardSpotlight className="stat wide coords">
          <span className="stat-l">Location</span>
          <span className="stat-v mono">{deg(p.lat, 'N', 'S')} · {deg(p.lng, 'E', 'W')}</span>
          <button className="stat-copy" onClick={() => void copy()}><FiCopy /> {copied ? 'Copied' : 'Copy coordinates'}</button>
        </CardSpotlight>
        {why && <p className="note stat-why">{why}</p>}
      </div>}

      {tab === 'forecast' && <div>
        {busy && <p className="note"><FiRefreshCw className="spin" /> Loading this river's forecast…</p>}
        {err && <p className="err"><FiAlertTriangle /> Forecast unavailable: {err}</p>}
        {detail && <Chart s={detail} p={p} />}
        {detail && <p className="note tight">Solid line: flow in m³/s, past 10 days and the next 7. Dashed lines: this point's own 2025 monsoon levels.</p>}
      </div>}

      {tab === 'villages' && <div>
        {vErr ? <p className="err"><FiAlertTriangle /> Village list unavailable: {vErr}</p>
          : !villages ? <p className="note"><FiRefreshCw className="spin" /> Loading villages…</p>
            : high
              ? (atRisk.length
                ? <ul className="vlist">{atRisk.slice(0, 40).map(v => <li key={v.id}><b>{v.n}</b><span>{v.dr.toFixed(1)} km from river · {v.h?.toFixed(1)} m above</span></li>)}</ul>
                : <p className="note">No village within the risk distance and height of this point.</p>)
              : <p className="note">{p.nv} village{p.nv === 1 ? '' : 's'} lie within 6 km of this point. They are listed here if the forecast reaches High.</p>}
      </div>}

      <p className="note dim tiny">GloFAS is a global river model on a ~5 km grid, not a gauge. Levels are compared with this point's own 2025 monsoon, so treat them as a first screen. Village risk is an estimate from distance and height above the river.</p>
    </div>
  )
}
