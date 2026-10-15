// Local river monitor: the same job the AWS Lambda + EventBridge Scheduler ran, on this machine.
// Every INTERVAL it reads the GloFAS river-discharge forecast for every river point (Open-Meteo flood API, batched),
// classifies each point against its own 2025 monsoon with the SAME rules as the website (classify() from aws-api), and keeps the
// snapshot in memory and on disk. The website reads it from /india/snapshot.json.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const DATA = join(here, 'data')
const FILE = join(DATA, 'snapshot.json')
const { classify } = await import(pathToFileURL(join(root, 'aws-api', 'dist', 'monitor.js')).href)
const points = JSON.parse(readFileSync(join(root, 'aws-api', 'data', 'rivers.json'), 'utf8')).points

const sleep = ms => new Promise(r => setTimeout(r, ms))
export const state = { snapshot: null, running: false, lastRunAt: null, lastOkAt: null, nextRunAt: null, lastError: '', runs: 0, intervalMin: 15, durationSec: null }

try { if (existsSync(FILE)) { state.snapshot = JSON.parse(readFileSync(FILE, 'utf8')); state.lastOkAt = state.snapshot.river?.created_at ?? null } } catch { /* start empty */ }

async function fetchBatch(batch) {
  const url = `https://flood-api.open-meteo.com/v1/flood?latitude=${batch.map(p => p.glat).join(',')}&longitude=${batch.map(p => p.glng).join(',')}&daily=river_discharge&past_days=3&forecast_days=8`
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (res.status === 429) throw Object.assign(new Error('Open-Meteo rate limit (429)'), { rateLimited: true })
  if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`)
  const body = await res.json()
  return Array.isArray(body) ? body : [body]
}

export async function runOnce(log = console.log) {
  if (state.running) return
  state.running = true
  const started = Date.now()
  const todayIso = new Date().toISOString().slice(0, 10)
  const rows = []
  let failed = 0
  try {
    for (let i = 0; i < points.length; i += 90) {
      const batch = points.slice(i, i + 90)
      try {
        if (i > 0) await sleep(13_000)   // the free tier counts every location, so batches are paced
        let raw
        try { raw = await fetchBatch(batch) } catch (e) {
          if (!e.rateLimited) throw e
          log('monitor: rate limited, waiting 60 s')
          await sleep(60_000)
          raw = await fetchBatch(batch)
        }
        batch.forEach((p, k) => {
          const d = raw[k]?.daily
          if (!d?.time || !d.river_discharge || d.time.length !== d.river_discharge.length || d.time.indexOf(todayIso) < 0) { failed++; return }
          rows.push(classify(p, d.time, d.river_discharge, todayIso))
        })
      } catch (e) { log('monitor: batch failed', i, String(e.message || e)); failed += batch.length }
    }
    // a batch can fail on a network blip: retry the missing points twice, then reuse their row from the previous snapshot
    for (let attempt = 0; attempt < 2; attempt++) {
      const have = new Set(rows.map(r => r[0]))
      const missing = points.filter(p => !have.has(p.id))
      if (!missing.length) break
      log(`monitor: retrying ${missing.length} missing points (attempt ${attempt + 1})`)
      await sleep(20_000)
      for (let i = 0; i < missing.length; i += 90) {
        const batch = missing.slice(i, i + 90)
        try {
          if (i > 0) await sleep(13_000)
          const raw = await fetchBatch(batch)
          batch.forEach((p, k) => {
            const d = raw[k]?.daily
            if (d?.time && d.river_discharge && d.time.length === d.river_discharge.length && d.time.indexOf(todayIso) >= 0) { rows.push(classify(p, d.time, d.river_discharge, todayIso)); failed-- }
          })
        } catch (e) { log('monitor: retry failed', String(e.message || e)) }
      }
    }
    {
      const have = new Set(rows.map(r => r[0]))
      const prevRows = new Map((state.snapshot?.river?.statuses ?? []).map(r => [r[0], r]))
      for (const p of points) if (!have.has(p.id) && prevRows.has(p.id)) { rows.push(prevRows.get(p.id)); log('monitor: kept previous reading for point', p.id) }
    }
    if (rows.length < points.length) throw new Error(`Only ${rows.length}/${points.length} points had valid data; keeping the previous snapshot`)
    if (false) throw new Error(`Only ${rows.length}/${points.length} points had valid data; keeping the previous snapshot`)
    const by = { NORMAL: 0, RISING: 0, WARNING: 0, DANGER: 0 }
    rows.forEach(r => by[r[1]]++)
    const byId = new Map(points.map(p => [p.id, p]))
    const flagged = rows.filter(r => r[1] !== 'NORMAL').map(r => ({ river: byId.get(r[0]).river, near: byId.get(r[0]).near, status: r[1], trend: r[6] }))
    const alertRivers = [...new Set(rows.filter(r => (r[1] === 'WARNING' || r[1] === 'DANGER') && r[6] === 'rising').map(r => byId.get(r[0]).river))]
    const rising = [...new Set(rows.filter(r => r[1] === 'RISING').map(r => byId.get(r[0]).river))]
    const headline = alertRivers.length ? `${alertRivers.length} river${alertRivers.length === 1 ? '' : 's'} rising to flood levels`
      : rising.length ? `${rising.length} river${rising.length === 1 ? '' : 's'} rising, none to flood levels yet` : by.WARNING + by.DANGER ? 'No river rising to flood levels' : 'All rivers normal'
    const snapshot = {
      river: { created_at: new Date().toISOString(), points: points.length, normal: by.NORMAL, rising: by.RISING, warning: by.WARNING, danger: by.DANGER, headline, flagged: flagged.slice(0, 40), statuses: rows },
      gandak: null,
      source: 'JalNetra monitor (local scheduler), GloFAS via Open-Meteo',
    }
    state.snapshot = snapshot
    state.lastOkAt = snapshot.river.created_at
    state.lastError = ''
    mkdirSync(DATA, { recursive: true })
    writeFileSync(FILE, JSON.stringify(snapshot))
    log(`monitor: ${rows.length}/${points.length} points · ${headline} · N${by.NORMAL} R${by.RISING} W${by.WARNING} D${by.DANGER} · ${failed} failed`)
  } catch (e) {
    state.lastError = String(e.message || e)
    log('monitor: run failed:', state.lastError)
  } finally {
    state.running = false
    state.lastRunAt = new Date().toISOString()
    state.runs++
    state.durationSec = Math.round((Date.now() - started) / 1000)
  }
}

export function startMonitor(intervalMin = 15, log = console.log) {
  state.intervalMin = intervalMin
  const loop = async () => {
    await runOnce(log)
    // a failed run is retried sooner (5 min) so a rate limit does not leave the data stale for a whole interval
    const wait = state.lastError ? Math.min(5, intervalMin) : intervalMin
    state.nextRunAt = new Date(Date.now() + wait * 60_000).toISOString()
    setTimeout(loop, wait * 60_000)
  }
  void loop()
}

export const publicStatus = () => ({
  running: state.running, intervalMin: state.intervalMin, lastRunAt: state.lastRunAt, lastOkAt: state.lastOkAt, nextRunAt: state.nextRunAt,
  runs: state.runs, durationSec: state.durationSec, lastError: state.lastError, points: points.length,
  headline: state.snapshot?.river?.headline ?? null,
  counts: state.snapshot ? { normal: state.snapshot.river.normal, rising: state.snapshot.river.rising, warning: state.snapshot.river.warning, danger: state.snapshot.river.danger } : null,
})
