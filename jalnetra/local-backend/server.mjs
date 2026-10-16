// Runs the real aws-api handler on this machine: embedded Postgres (PGlite) + .env credentials. Nothing here touches AWS.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { publicStatus, runOnce, startMonitor, state as monitorState } from './monitor.mjs'
import { createEscalation } from './escalation.mjs'
import { buildNdrfPdfBytes } from '../src/report/ndrfReport.ts'
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
for (const f of [join(root, '..', '.env'), join(root, '.env')]) {
  try { for (const l of readFileSync(f, 'utf8').split(/\r?\n/)) { const m = l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '') } } catch {}
}
const E = process.env
E.JN_PROXY_CACHE_FILE ||= join(here, 'data', 'proxy-cache.json')
// .env names -> names the handler reads. The demo phone is the number from .env, never one stored in AWS.
// Stage 1 of the exercise escalation goes to the Sarpanch (ALERT_PHONE_NUMBER1); stage 2 (citizens) uses ALERT_PHONE_NUMBER2.
E.JN_ALERT_PHONE = E.ALERT_PHONE_NUMBER1 || E.DEMO_PHONE_NUMBER || E.ALERT_PHONE_NUMBER
// The flood-alert voice agent (created in Omnidim for JalNetra: speaks alert_message, Hindi then English). The older
// women's-safety agent in .env says "check Telegram" and ignores the message, so it is not used here.
E.OMNIDIM_AGENT = E.FLOOD_AGENT_ID || '269919'
E.JALNETRA_PUBLIC_DEMO = 'true'
delete E.JALNETRA_DATABASE_SECRET_ARN; delete E.JALNETRA_TELEPHONY_SECRET_ARN; delete E.JALNETRA_ALERT_TOPIC_ARN; delete E.JALNETRA_WORKFLOW_ARN

const dbPort = 54329
const db = await PGlite.create()
const schema = readFileSync(join(root, 'aws-api', 'schema.sql'), 'utf8').replace(/CREATE EXTENSION[^;]*;/gi, '')
await db.exec(schema)
await new PGLiteSocketServer({ db, port: dbPort, host: '127.0.0.1' }).start()
Object.assign(E, { PGHOST: '127.0.0.1', PGPORT: String(dbPort), PGDATABASE: 'postgres', PGUSER: 'postgres', PGPASSWORD: 'x', PGPOOL_MAX: '1' })

const { handler } = await import(pathToFileURL(join(root, 'aws-api', 'dist', 'handler.js')).href)
const port = Number(E.LOCAL_BACKEND_PORT || 8787)
const { dispatchAlert, dispatchRefs } = await import(pathToFileURL(join(root, 'aws-api', 'dist', 'telephony.js')).href)
const escalation = createEscalation({
  env: E, dispatch: dispatchAlert, file: join(here, 'data', 'escalations.json'), dryRun: E.ESCALATION_DRY_RUN === '1',
  log: (...a) => console.log(new Date().toISOString().slice(11, 19), 'escalation:', ...a),
  requestIdFor: r => dispatchRefs.get(`demo-${r.alertId}`) ?? null,
  buildPdf: input => buildNdrfPdfBytes(input),
})
escalation.resumePending()
// ---- Listen in Hindi: local text-to-speech (Microsoft Edge neural voice). Replaces Amazon Polly; no AWS involved. ----
const audio = new Map()   // id -> mp3 Buffer
function synthesize(text, voice) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [join(here, 'tts-worker.mjs'), voice, Buffer.from(text, 'utf8').toString('base64')], { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, timeout: 30000 }, (err, stdout, stderr) => {
      if (err || !stdout.length) reject(new Error(String(stderr || err?.message || 'empty audio')))
      else resolve(stdout)
    })
  })
}
const sendJson = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(body)) }

createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x')
  if (req.method === 'GET' && u.pathname === '/india/snapshot.json') {
    if (!monitorState.snapshot) { res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '30' }); return res.end(JSON.stringify({ error: 'The first monitor run is still in progress' })) }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(monitorState.snapshot))
  }
  if (req.method === 'GET' && u.pathname === '/monitor/status') return sendJson(res, 200, publicStatus())
  if (req.method === 'POST' && u.pathname === '/monitor/run') { void runOnce(); return sendJson(res, 202, { started: true }) }
  if (req.method === 'GET' && u.pathname.startsWith('/audio/')) {
    const buf = audio.get(u.pathname.slice(7).replace(/\.mp3$/, ''))
    if (!buf) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': buf.length, 'cache-control': 'public, max-age=3600' }); return res.end(buf)
  }
  // ---- Walking directions: OpenStreetMap foot routing (replaces Amazon Location Service) ----
  if (req.method === 'GET' && u.pathname === '/ai/route') {
    try {
      const pt = v => { const m = String(v ?? '').match(/^(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/); return m ? [Number(m[1]), Number(m[2])] : null }
      const from = pt(u.searchParams.get('from')), to = pt(u.searchParams.get('to'))
      if (!from || !to) return sendJson(res, 400, { error: "from and to must be 'lat,lng'" })
      const r = await fetch(`https://routing.openstreetmap.de/routed-foot/route/v1/foot/${from[1]},${from[0]};${to[1]},${to[0]}?overview=full&geometries=geojson&steps=true`, { signal: AbortSignal.timeout(15000) })
      const d = await r.json()
      const route = d.routes?.[0]
      if (!r.ok || !route) return sendJson(res, 404, { error: 'No walking route found' })
      const dist = m => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`)
      const steps = route.legs.flatMap(l => l.steps).filter(st => st.distance > 0).map(st => {
        const mod = st.maneuver?.modifier ? st.maneuver.modifier.replace(/^slight /, 'slightly ') : ''
        const verb = st.maneuver?.type === 'arrive' ? 'Arrive' : st.maneuver?.type === 'depart' ? 'Start' : mod ? `Turn ${mod}` : 'Continue'
        return { meters: Math.round(st.distance), minutes: Math.max(1, Math.round(st.duration / 60)), direction: mod || 'straight', text: `${verb}${st.name ? ` on ${st.name}` : ''} for ${dist(st.distance)}` }
      })
      return sendJson(res, 200, { km: Number((route.distance / 1000).toFixed(2)), minutes: Math.round(route.duration / 60), path: route.geometry.coordinates, steps, source: 'OpenStreetMap (foot routing)' })
    } catch (e) { console.error('route failed', e); return sendJson(res, 502, { error: 'Walking directions are unavailable right now. Try again shortly.' }) }
  }
  // ---- Advisory draft: fact-bound Hindi + English text built from the page's own facts (replaces Bedrock) ----
  if (req.method === 'POST' && u.pathname === '/ai/advisory') {
    let raw = ''; for await (const c of req) { raw += c; if (raw.length > 8000) break }
    let b = {}; try { b = JSON.parse(raw || '{}') } catch {}
    const f = k => String(b[k] ?? '').replace(/[\u0000-\u001F]/g, ' ').trim().slice(0, 100)
    const village = f('village'); if (!village) return sendJson(res, 400, { error: 'village is required' })
    const district = f('district'), risk = f('risk').toUpperCase(), impact = f('impact'), shelter = f('shelter'), km = f('km'), ex = b.exercise === true
    const HI = { CRITICAL: 'अति गंभीर', HIGH: 'गंभीर', MEDIUM: 'मध्यम', LOW: 'कम' }
    const place = district ? `${village}, ${district}` : village
    const impactHi = impact.replace(/hours?/gi, 'घंटे').replace(/now/gi, 'अभी')
    const en = `${ex ? 'EXERCISE: ' : ''}Flood warning for ${place}. Risk level: ${risk || 'flood'}${impact ? `, water expected ${impact}` : ''}. Move to ${shelter || 'the nearest high ground'}${km ? ` (${km} km)` : ''} now. Take children, elderly people and pregnant women first, and inform the panchayat.`
    const hi = `${ex ? 'यह एक अभ्यास संदेश है। ' : ''}${place} के लिए बाढ़ की चेतावनी। खतरा: ${HI[risk] || risk || 'बाढ़'}${impact ? `, पानी ${impactHi} में आने की संभावना` : ''}। कृपया अभी ${shelter || 'नज़दीकी ऊँची जगह'}${km ? ` (${km} किमी)` : ''} पर जाएँ। बच्चों, बुज़ुर्गों और गर्भवती महिलाओं को सबसे पहले ले जाएँ और पंचायत को सूचित करें।`
    return sendJson(res, 200, { hi, en, model: 'local template', drafted: true })
  }
  if (req.method === 'POST' && u.pathname === '/ai/tts') {
    try {
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > 20000) break }
      const body = JSON.parse(raw || '{}')
      const text = String(body.text ?? '').replace(/[ --]/g, '').trim().slice(0, 1500)
      if (text.length < 2) return sendJson(res, 400, { error: 'text is required' })
      const voice = body.lang === 'en' ? (body.voice === 'Aditi' ? 'en-IN-PrabhatNeural' : 'en-IN-NeerjaNeural') : body.voice === 'Aditi' ? 'hi-IN-MadhurNeural' : 'hi-IN-SwaraNeural'
      const id = createHash('sha256').update(voice + '|' + text).digest('hex').slice(0, 32)
      const cached = audio.has(id)
      if (!cached) { audio.set(id, await synthesize(text, voice)); if (audio.size > 100) audio.delete(audio.keys().next().value) }
      return sendJson(res, 200, { url: `/jn/audio/${id}.mp3`, voice, cached, characters: text.length })
    } catch (e) { console.error('tts failed', e); return sendJson(res, 502, { error: 'Speech synthesis is unavailable right now. Try again shortly.' }) }
  }
  // ---- Two-stage escalation: Sarpanch (number 1) decides, then citizens (number 2) are called ----
  {
    const m = u.pathname.match(/^\/escalation\/([0-9a-f-]{36})$/)
    if (req.method === 'GET' && m) { const v = escalation.status(m[1]); return v ? sendJson(res, 200, v) : sendJson(res, 404, { error: 'Not found' }) }
    const a = u.pathname.match(/^\/escalation\/by-alert\/([0-9a-f-]{36})\/([0-9a-f-]{36})$/)
    if (req.method === 'GET' && a) { const v = escalation.statusByAlert(a[1], a[2]); return v ? sendJson(res, 200, v) : sendJson(res, 404, { error: 'Not found' }) }
    if (req.method === 'POST' && u.pathname === '/escalation/report-input') {
      // The page posts the report data at approval; the server builds and sends the PDF the moment the alert is escalated.
      const chunks = []; let size = 0
      for await (const c of req) { size += c.length; if (size > 8 * 1024 * 1024) return sendJson(res, 413, { error: 'too large' }); chunks.push(c) }
      const sessionId = u.searchParams.get('sessionId') ?? '', alertId = u.searchParams.get('alertId') ?? ''
      if (!/^[0-9a-f-]{36}$/.test(sessionId) || !/^[0-9a-f-]{36}$/.test(alertId)) return sendJson(res, 400, { error: 'invalid ids' })
      try { escalation.setReportInput(sessionId, alertId, JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { return sendJson(res, 400, { error: 'invalid JSON' }) }
      return sendJson(res, 200, { ok: true })
    }
    if (req.method === 'POST' && u.pathname === '/escalation/ndrf-send') {
      const chunks = []; let size = 0
      for await (const c of req) { size += c.length; if (size > 12 * 1024 * 1024) return sendJson(res, 413, { error: 'file too large' }); chunks.push(c) }
      const buffer = Buffer.concat(chunks)
      if (buffer.length < 1000 || buffer.subarray(0, 4).toString('latin1') !== '%PDF') return sendJson(res, 400, { error: 'a PDF file is required' })
      const q = k => String(u.searchParams.get(k) ?? '')
      const filename = (q('name') || 'NDRF-flood-advisory.pdf').replace(/[^\w.\- ]/g, '_').slice(0, 80)
      const out = await escalation.manualNdrf({ sessionId: /^[0-9a-f-]{36}$/.test(q('sessionId')) ? q('sessionId') : '', alertId: /^[0-9a-f-]{36}$/.test(q('alertId')) ? q('alertId') : '', buffer, filename, caption: q('caption') || 'JalNetra flood advisory for NDRF' })
      return sendJson(res, out.ok ? 200 : 502, out.ok ? { ok: true, to: 'NDRF bot' } : { error: out.note })
    }
    if (req.method === 'POST' && u.pathname === '/escalation/call-result') {
      let raw = ''; for await (const c of req) { raw += c; if (raw.length > 8000) break }
      let b = {}; try { b = JSON.parse(raw || '{}') } catch {}
      const token = String(req.headers['x-escalation-token'] ?? b.token ?? '')
      const out = await escalation.callResult(b, token)
      return sendJson(res, out.status, out.body)
    }
  }
  const chunks = []; for await (const c of req) chunks.push(c)
  const url = new URL(req.url, 'http://x')
  let body = Buffer.concat(chunks).toString('utf8')
  // The page may attach the stage-2 (citizen) message to an approval. It is not part of the demo API contract, so strip it here.
  let citizen = null
  const approve = req.method === 'POST' ? url.pathname.match(/^\/demo\/sessions\/([0-9a-f-]{36})\/alerts\/([0-9a-f-]{36})\/approve$/) : null
  if (approve) {
    try {
      const b = JSON.parse(body || '{}')
      if (b.citizenMessageHi || b.citizenMessageEn) citizen = { hi: b.citizenMessageHi, en: b.citizenMessageEn }
      delete b.citizenMessageHi; delete b.citizenMessageEn
      body = JSON.stringify(b)
    } catch { /* the handler will reject a malformed body */ }
  }
  const event = {
    version: '2.0', rawPath: url.pathname, rawQueryString: url.search.slice(1), headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
    queryStringParameters: Object.fromEntries(url.searchParams), body: body || undefined, isBase64Encoded: false,
    requestContext: { http: { method: req.method, path: url.pathname, sourceIp: req.socket.remoteAddress ?? 'local' } },
  }
  try {
    const r = await handler(event, {}, () => {})
    // Stage 1 succeeded (the real call to the Sarpanch was dispatched): open the escalation and ask for the Sarpanch's decision.
    if (approve && r.statusCode === 200) {
      try {
        const out = JSON.parse(r.body ?? '{}')
        const al = out.alert
        if (out.replayed === false && al?.callStatus === 'dispatched') {
          void escalation.open({ sessionId: approve[1], alertId: approve[2], village: al.prediction?.villageName, district: al.prediction?.district, horizonHours: al.prediction?.horizonHours ?? null, stage1Status: 'dispatched', citizen })
            .catch(e => console.error('escalation open failed', e))
        }
      } catch { /* not JSON */ }
    }
    res.writeHead(r.statusCode ?? 200, r.headers ?? {}); res.end(r.body ?? '')
  } catch (e) { console.error(e); res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e.message || e) })) }
}).listen(port, '127.0.0.1', () => console.log(`local backend on http://127.0.0.1:${port}; sarpanch phone ends ${String(E.JN_ALERT_PHONE).slice(-4)}, citizen phone ends ${String(E.ALERT_PHONE_NUMBER2 ?? '').slice(-4)}`))

// ---- the scheduled job, run locally: every MONITOR_INTERVAL_MIN (default 180) minutes ----
startMonitor(Number(E.MONITOR_INTERVAL_MIN || 180), (...a) => console.log(new Date().toISOString().slice(11, 19), ...a))
