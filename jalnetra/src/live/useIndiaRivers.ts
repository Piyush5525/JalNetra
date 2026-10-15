import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { summarise, STATUS_ORDER, type PointStatus, type RiverPoint } from '../engine/india'

/** Below this flow (m³/s) a point is a small stream. With one monsoon of history, a trickle can look "above the peak"; it is not flagged. */
export const MIN_FLOW = 50
export type Attention = { s: PointStatus; p: RiverPoint; more: number }
import { isFresh, refreshRun, requestJson, type Run } from './riverWatchData'

export type IndiaData = { points: RiverPoint[]; lines: { river: string; path: number[][] }[] }

/**
 * India-wide river network for the live map. It uses the same data pipeline as River Watch: the JalNetra monitor snapshot first,
 * then fresh GloFAS data. When the weather service rate-limits, the last verified snapshot stays on screen (clearly dated) and
 * the hook quietly retries; missing data is never turned into "Normal".
 */
export function useIndiaRivers() {
  const [data, setData] = useState<IndiaData | null>(null)
  const [run, setRun] = useState<Run | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [clock, setClock] = useState(Date.now())
  const prev = useRef<Run | null>(null)
  const cooldown = useRef(0)
  const inflight = useRef<AbortController | null>(null)
  const lastTry = useRef(Date.now())

  useEffect(() => { const id = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(id) }, [])

  useEffect(() => {
    const controller = new AbortController()
    requestJson('/india/rivers.json', controller.signal).then(value => {
      if (controller.signal.aborted) return
      const d = value as IndiaData
      if (!Array.isArray(d?.points) || !d.points.length || !Array.isArray(d.lines)) throw new Error('Invalid river list')
      setData(d)
    }).catch(e => { if (!controller.signal.aborted) setErr('Could not load the river list: ' + (e as Error).message) })
    return () => controller.abort()
  }, [])

  const refresh = useCallback(async () => {
    if (!data || inflight.current || Date.now() < cooldown.current) return
    const controller = new AbortController()
    inflight.current = controller
    setBusy(true)
    try {
      const result = await refreshRun(data.points, prev.current, controller.signal)
      if (controller.signal.aborted) return
      if (result.run) { prev.current = result.run; setRun(result.run) }
      setErr(result.error)
      if (result.retryAt) cooldown.current = Math.max(cooldown.current, result.retryAt)
    } catch (e) {
      if (!controller.signal.aborted) setErr('River data unavailable: ' + (e as Error).message)
    } finally {
      if (inflight.current === controller) inflight.current = null
      setBusy(false)
    }
  }, [data])

  // First load as soon as the river list is in; then every 90 s while the data is stale or missing, every 15 min once fresh.
  useEffect(() => { if (data) void refresh() }, [data, refresh])
  useEffect(() => {
    if (!data) return
    const id = setInterval(() => {
      const stale = !prev.current || !isFresh(prev.current)
      if (Date.now() - lastTry.current >= (stale ? 90e3 : 15 * 60e3)) { lastTry.current = Date.now(); void refresh() }
    }, 15e3)
    return () => clearInterval(id)
  }, [data, refresh])

  const points = useMemo(() => new Map((data?.points ?? []).map(p => [p.id, p])), [data])
  // Points whose flow (and 2025 baseline) is a trickle are treated as Normal, so a 21 m³/s stream is not painted red.
  const gated = useMemo(() => (run?.statuses ?? []).map(s => {
    const p = points.get(s.id)
    return s.status !== 'NORMAL' && p && Math.max(s.peak, p.max) < MIN_FLOW ? { ...s, status: 'NORMAL' as const } : s
  }), [run, points])
  const statuses = useMemo(() => new Map(gated.map(s => [s.id, s] as [number, PointStatus])), [gated])
  const summary = useMemo(() => (run && data ? summarise(gated, points) : null), [run, data, points, gated])
  // One row per river (its worst point), rising rivers first, then by severity. "High but falling" ranks below "rising".
  const attention = useMemo<Attention[]>(() => {
    const worst = new Map<string, Attention>()
    const rank = (s: PointStatus) => (s.trend === 'rising' ? 0 : 1) * 10 - STATUS_ORDER.indexOf(s.status) * 2 - Math.min(s.ratio, 1.9)
    for (const s of gated) {
      if (s.status === 'NORMAL') continue
      const p = points.get(s.id); if (!p) continue
      const cur = worst.get(p.river)
      if (!cur) worst.set(p.river, { s, p, more: 0 })
      else { cur.more += 1; if (rank(s) < rank(cur.s)) { cur.s = s; cur.p = p } }
    }
    return [...worst.values()].sort((a, b) => rank(a.s) - rank(b.s))
  }, [gated, points])
  const stale = !!run && !isFresh(run, clock)
  const waitSeconds = Math.max(0, Math.ceil((cooldown.current - clock) / 1000))
  return { data, run, err, busy, stale, refresh, points, statuses, summary, attention, waitSeconds }
}
