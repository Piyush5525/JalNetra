// Two-stage alert escalation for the exercise alerts.
//
//   Stage 1  operator approves  -> IVR call to the Sarpanch (ALERT_PHONE_NUMBER1, message unchanged)
//   Decision Sarpanch says it is real or a false alarm:
//              * Telegram: "Escalate now" / "Reject" buttons (works without a public URL, via long polling)
//              * Call: a provider webhook can post "1/yes" or "2/no" to /escalation/call-result (needs a public URL)
//   Stage 2  only after "escalate" -> IVR call to a citizen number (ALERT_PHONE_NUMBER2) with a different message:
//              leave the area now and go to safe ground.
//
// Safety: numbers come from the server environment only, never from a request. Each escalation places at most one
// stage-2 call, a decision is single-use, and nothing is escalated unless the Sarpanch said so.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const TERMINAL = new Set(['escalated', 'rejected', 'expired', 'failed'])
const mask = p => (p ? `•••• ${String(p).slice(-4)}` : null)
const clean = (v, max = 900) => (typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '')

/** Stage-2 message for a citizen inside the evacuation zone: one short, urgent line in Hindi, then English. */
export function citizenMessages({ village, hours, shelter = null, exercise = false }) {
  const whenHi = hours === null || hours === undefined ? 'जल्द ही' : hours === 0 ? 'अभी' : `लगभग ${hours} घंटे में`
  const whenEn = hours === null || hours === undefined ? 'soon' : hours === 0 ? 'right now' : `in about ${hours} hours`
  const goHi = shelter || 'नज़दीकी सुरक्षित ऊँची जगह'
  const goEn = shelter || 'the nearest safe high ground'
  return {
    hi: `बाढ़ का खतरा! आपके क्षेत्र में बाढ़ आ रही है और ${whenHi} पहुँचेगी। कृपया तुरंत ${goHi} पर पहुँचें।${exercise ? ' यह अभ्यास है।' : ''}`,
    en: `Flood alert! Flood is coming to your area and will arrive ${whenEn}. Please reach ${goEn} immediately.${exercise ? ' This is an exercise.' : ''}`,
  }
}

export function createEscalation({ env, dispatch, fetchFn = fetch, now = () => Date.now(), file, log = console.log, dryRun = false, pollMs = 1500, retryMs = 10_000, callPollMs = 8_000, requestIdFor = () => null }) {
  const records = new Map()   // id -> record
  const byKey = new Map()     // `${sessionId}:${alertId}` -> id
  const ttlMs = Number(env.ESCALATION_TTL_MIN || 20) * 60_000
  const sarpanchPhone = () => env.ALERT_PHONE_NUMBER1 || env.JN_SARPANCH_PHONE || ''
  const citizenPhone = () => env.ALERT_PHONE_NUMBER2 || env.JN_CITIZEN_PHONE || ''
  const tgToken = () => env.TELEGRAM_BOT_TOKEN || ''
  const tgChat = () => String(env.TELEGRAM_CHAT_ID || '')
  const webhookToken = () => env.ESCALATION_WEBHOOK_TOKEN || env.DEMO_TOKEN || ''
  let lastCitizenCall = 0
  let polling = false, offset = 0, stopPoll = false
  const busy = r => /concurrency|busy|limit/i.test(String(r?.error ?? ''))
  const sarpanchAgent = () => env.OMNIDIM_SARPANCH_AGENT_ID || env.OMNIDIM_SARPANCH_AGENT || ''
  const omnidimKey = () => env.OMNIDIM_API_KEY || env.OMNIDIM_KEY || ''

  const save = () => {
    if (!file) return
    try { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify([...records.values()])) } catch { /* best effort */ }
  }
  try {
    if (file && existsSync(file)) for (const r of JSON.parse(readFileSync(file, 'utf8'))) { records.set(r.id, r); byKey.set(r.key, r.id) }
  } catch { /* start empty */ }

  const event = (r, text, kind = 'info') => { r.events.push({ at: new Date(now()).toISOString(), text, kind }); save() }
  const expire = r => {
    if (!TERMINAL.has(r.status) && now() > r.expiresAt) { r.status = 'expired'; event(r, 'No decision from the Sarpanch in time. Nothing was escalated.', 'warn') }
    return r
  }
  const view = r => {
    expire(r)
    return {
      id: r.id, status: r.status, village: r.village, district: r.district, horizonHours: r.horizonHours, exercise: true,
      createdAt: r.createdAt, expiresAt: new Date(r.expiresAt).toISOString(), decidedAt: r.decidedAt ?? null, decidedVia: r.decidedVia ?? null,
      sarpanch: { phone: mask(sarpanchPhone()), call: r.stage1 },
      citizen: { phone: mask(citizenPhone()), call: r.citizenCall },
      acknowledged: Boolean(r.acknowledged),
      channels: { telegram: Boolean(tgToken() && tgChat()), callWebhook: Boolean(webhookToken()) },
      citizenMessage: r.citizen, events: r.events,
    }
  }

  // ---- Telegram (long polling: no public URL needed) ----
  async function tg(method, payload) {
    if (dryRun || !tgToken()) return { ok: false, dry: true }
    const res = await fetchFn(`https://api.telegram.org/bot${tgToken()}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(35_000) })
    return res.json().catch(() => ({ ok: false }))
  }
  async function notifyTelegram(r) {
    if (!tgToken() || !tgChat()) { event(r, 'Telegram is not configured: the decision can only arrive through the call webhook.', 'warn'); return }
    const text = `🚨 JalNetra FLOOD ALERT\n\n${r.village}${r.district ? `, ${r.district}` : ''}: flood water expected ${r.horizonHours ? `in about ${r.horizonHours} h` : 'soon'}.\nThe Sarpanch has been called and is asked to confirm on the call (say yes or press 1 / say no or press 0).\n\nIs this real? You can also choose here:\n• Escalate now: citizens in the zone get a "leave the area" call\n• Reject: false alarm, nothing more is sent\n\nThe first answer counts.`
    const out = await tg('sendMessage', { chat_id: tgChat(), text, reply_markup: { inline_keyboard: [[{ text: '✅ Escalate now', callback_data: `esc:${r.id}:go` }, { text: '❌ Reject (false alarm)', callback_data: `esc:${r.id}:no` }]] } })
    if (out?.ok) { r.telegramMessageId = out.result?.message_id; event(r, 'Decision request sent to Telegram (Escalate now / Reject).'); startPolling() }
    else if (out?.dry) event(r, 'Dry run: Telegram message not sent.', 'info')
    else event(r, `Telegram message failed: ${out?.description ?? 'unknown error'}`, 'warn')
  }
  /** Remove the buttons and tell the chat what happened, so Telegram always shows the true state. */
  async function syncTelegram(r, text) {
    if (!tgToken() || !tgChat()) return
    if (r.telegramMessageId) await tg('editMessageReplyMarkup', { chat_id: tgChat(), message_id: r.telegramMessageId, reply_markup: { inline_keyboard: [] } }).catch(() => {})
    await tg('sendMessage', { chat_id: tgChat(), text }).catch(() => {})
  }
  async function pollOnce() {
    const out = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['callback_query'] })
    if (!out?.ok) return false
    for (const u of out.result ?? []) {
      offset = Math.max(offset, u.update_id + 1)
      const cb = u.callback_query
      if (!cb) continue
      const m = /^esc:([0-9a-f-]{36}):(go|no)$/.exec(cb.data ?? '')
      const fromChat = String(cb.message?.chat?.id ?? '')
      if (!m || fromChat !== tgChat()) { await tg('answerCallbackQuery', { callback_query_id: cb.id, text: 'Not allowed.' }); continue }
      const result = await decide(m[1], m[2] === 'go' ? 'escalate' : 'reject', `Telegram (${cb.from?.first_name ?? 'user'})`)
      await tg('answerCallbackQuery', { callback_query_id: cb.id, text: result.message.slice(0, 190) })
    }
    return true
  }
  function startPolling() {
    if (polling || dryRun || !tgToken()) return
    polling = true; stopPoll = false
    void (async () => {
      try {
        await tg('deleteWebhook', { drop_pending_updates: false })   // getUpdates is refused while a webhook is set
        while (!stopPoll) {
          const pending = [...records.values()].some(r => !TERMINAL.has(expire(r).status))
          if (!pending) break
          const ok = await pollOnce().catch(() => false)
          if (!ok) await new Promise(r => setTimeout(r, 4000))
          else await new Promise(r => setTimeout(r, pollMs))
        }
      } finally { polling = false }
    })()
  }

  // ---- state machine ----
  /** Called after the stage-1 call to the Sarpanch has been dispatched. Idempotent per session + alert. */
  async function open({ sessionId, alertId, village, district = '', horizonHours = null, stage1Status = 'dispatched', citizen = null, level = '' }) {
    const key = `${sessionId}:${alertId}`
    const existing = byKey.get(key)
    if (existing) return view(records.get(existing))
    const hours = Number.isFinite(horizonHours) ? horizonHours : null
    const r = {
      id: randomUUID(), key, alertId, sessionId, village: clean(village, 80), district: clean(district, 80), level: clean(level, 20), horizonHours: hours,
      status: 'awaiting_sarpanch', createdAt: new Date(now()).toISOString(), expiresAt: now() + ttlMs,
      stage1: { status: stage1Status, note: 'IVR call to the Sarpanch with the standard advisory' }, citizenCall: null,
      citizen: { hi: clean(citizen?.hi) || null, en: clean(citizen?.en) || null }, events: [],
    }
    records.set(r.id, r); byKey.set(key, r.id)
    event(r, 'Operator approved the alert.', 'ok')
    event(r, `IVR call to the Sarpanch (${mask(sarpanchPhone()) ?? 'number not configured'}): ${stage1Status}.`, stage1Status === 'dispatched' ? 'ok' : 'warn')
    await notifyTelegram(r)
    event(r, 'Waiting for the Sarpanch to confirm or reject.')
    void followCall(r)
    return view(r)
  }

  /** Two-way voice: the Sarpanch agent asks yes/no on the call; its extracted answer is read back from the provider's call log. */
  async function followCall(r) {
    const requestId = requestIdFor(r)
    if (dryRun || !omnidimKey() || requestId === null || requestId === undefined) return
    const url = `https://backend.omnidim.io/api/v1/calls/logs?pagesize=20${sarpanchAgent() ? `&agentid=${encodeURIComponent(sarpanchAgent())}` : ''}`
    let told = false
    while (r.status === 'awaiting_sarpanch' && now() < r.expiresAt) {
      await new Promise(res => setTimeout(res, callPollMs))
      try {
        const res = await fetchFn(url, { headers: { Authorization: `Bearer ${omnidimKey()}` }, signal: AbortSignal.timeout(15_000) })
        if (!res.ok) continue
        const rows = (await res.json())?.call_log_data ?? []
        const row = rows.find(x => String(x?.call_request_id?.id ?? x?.call_request_id) === String(requestId))
        if (!row) continue
        const raw = row.extracted_variables?.decision
        const answer = String(typeof raw === 'object' && raw ? (raw.value ?? raw.answer ?? '') : raw ?? '').toLowerCase()
        if (/escalat/.test(answer)) { await decide(r.id, 'escalate', 'the call'); return }
        if (/reject/.test(answer)) { await decide(r.id, 'reject', 'the call'); return }
        if (/acknowledg/.test(answer) && !r.acknowledged) {
          r.acknowledged = true
          event(r, 'The Sarpanch heard the full message (pressed or said two). No decision yet: waiting for escalate or reject.', 'info')
          void syncTelegram(r, `ℹ️ ${r.village}: the Sarpanch heard the full message on the call but has not decided yet. Use the buttons above.`)
        }
        const ended = ['completed', 'no-answer', 'busy', 'failed', 'canceled'].includes(String(row.call_status ?? '').toLowerCase())
        if (ended && !told) {
          told = true
          event(r, row.call_status === 'completed' ? 'The call ended without a clear yes or no. Waiting for the Telegram decision.' : `The Sarpanch call ended (${row.call_status}). Waiting for the Telegram decision.`, 'warn')
        }
        if (ended && row.call_status !== 'completed') return
        if (ended && row.call_status === 'completed' && answer && answer !== 'none' && !/acknowledg/.test(answer)) return
        if (ended && /acknowledg/.test(answer)) return
      } catch { /* try again */ }
    }
  }

  /** The Sarpanch's decision. Single-use: only the first one counts. */
  async function decide(id, decision, via) {
    const r = records.get(id)
    if (!r) return { ok: false, message: 'Unknown alert.' }
    expire(r)
    if (r.status !== 'awaiting_sarpanch') return { ok: false, message: `Already ${r.status}. No further action.` }
    r.decidedAt = new Date(now()).toISOString(); r.decidedVia = via
    if (decision !== 'escalate') {
      r.status = 'rejected'; event(r, `Sarpanch rejected the alert as a false alarm (via ${via}). Nothing was escalated.`, 'warn')
      await syncTelegram(r, `❌ ${r.village}: rejected as a false alarm (via ${via}). Nothing else is sent.`)
      return { ok: true, message: `Rejected: ${r.village} alert closed as a false alarm. No citizen call was placed.` }
    }
    r.status = 'escalating'; r.escalatedAt = now()
    event(r, `Sarpanch confirmed the alert (via ${via}). Escalating to citizens in the evacuation zone.`, 'ok')
    await syncTelegram(r, `✅ ${r.village}: escalated (via ${via}). Citizens in the evacuation zone are being called.`)
    const msgs = { hi: r.citizen.hi, en: r.citizen.en }
    const fallback = citizenMessages({ village: r.village, hours: r.horizonHours })
    const hi = msgs.hi || fallback.hi, en = msgs.en || fallback.en
    r.citizen = { hi, en }
    if (now() - lastCitizenCall < 30_000) { r.status = 'failed'; r.citizenCall = { status: 'blocked', note: 'Cooldown: another citizen call was placed in the last 30 s.' }; event(r, r.citizenCall.note, 'warn'); return { ok: false, message: r.citizenCall.note } }
    lastCitizenCall = now()
    if (dryRun || !citizenPhone()) {
      r.status = dryRun ? 'escalated' : 'failed'
      r.citizenCall = { status: dryRun ? 'dry_run' : 'not_configured', note: dryRun ? 'Dry run: no call placed.' : 'ALERT_PHONE_NUMBER2 is not configured.' }
      event(r, r.citizenCall.note, dryRun ? 'info' : 'warn')
      return { ok: true, message: `Escalated: ${dryRun ? 'dry run' : 'no citizen number configured'}.` }
    }
    return deliverCitizenCall(r, hi, en)
  }

  /** Stage 2. The provider allows few simultaneous calls, so a busy line is retried until the Sarpanch call has ended. */
  async function deliverCitizenCall(r, hi, en, attempt = 1) {
    const result = await dispatch('omnidimension', 'call', { id: null, name: 'Citizen (zone)', phone: citizenPhone() }, `${hi} ... ${en}`,
      { place: `${r.village}${r.district ? `, ${r.district}` : ''}`, title: `${r.village} flood evacuation notice`, source: 'JalNetra flood model', observed: 'Flood forecast', safe_place: 'nearest school or panchayat building on high ground' },
      `esc-${r.id}`, { timeoutMs: 10_000, agentId: env.OMNIDIM_CITIZEN_AGENT_ID || undefined })
    r.citizenCall = { status: result.status, note: result.error ?? null, attempts: attempt }
    if (result.status === 'sent' || result.status === 'unknown') {
      r.status = 'escalated'
      event(r, result.status === 'sent' ? `Citizen call dispatched (stage 2${attempt > 1 ? `, attempt ${attempt}` : ''}). This does not confirm anyone answered.` : 'Citizen call outcome unknown: the provider did not confirm. It will not be retried.', result.status === 'sent' ? 'ok' : 'warn')
      void tg('sendMessage', { chat_id: tgChat(), text: result.status === 'sent' ? `📞 Citizen call placed for ${r.village} (stage 2).` : `⚠️ Citizen call for ${r.village}: outcome unknown, not retried.` })
      return { ok: true, message: `Escalated: citizens in ${r.village}'s evacuation zone are being called.` }
    }
    const waitUntil = r.escalatedAt + Number(env.ESCALATION_CALL_RETRY_MIN || 10) * 60_000
    if (busy(result) && now() < waitUntil) {
      r.status = 'escalating'
      if (attempt === 1) event(r, 'The phone line is busy (the Sarpanch call is still running). Retrying until it is free.', 'warn')
      setTimeout(() => { void deliverCitizenCall(r, hi, en, attempt + 1).catch(e => event(r, `Retry failed: ${e}`, 'warn')) }, retryMs)
      return { ok: true, message: `Escalated. The line is busy; the citizen call for ${r.village} will go out as soon as it is free.` }
    }
    r.status = 'failed'
    event(r, `Citizen call ${result.status}${result.error ? `: ${result.error}` : ''}.`, 'warn')
    void tg('sendMessage', { chat_id: tgChat(), text: `⚠️ Citizen call for ${r.village} failed: ${result.error ?? result.status}.` })
    return { ok: true, message: `Escalation recorded but the citizen call ${result.status}.` }
  }

  const findByAlert = (sessionId, alertId) => { const id = byKey.get(`${sessionId}:${alertId}`); return id ? records.get(id) : null }
  const findByAlertId = alertId => [...records.values()].find(r => r.alertId === alertId) ?? null

  return {
    open, decide, startPolling, view,
    status: id => { const r = records.get(id); return r ? view(r) : null },
    statusByAlert: (sessionId, alertId) => { const r = findByAlert(sessionId, alertId); return r ? view(r) : null },
    /** Call provider webhook: { escalation_id | metadata.incident_id, response: "1" | "yes" | "2" | "no" }. */
    async callResult(body, token) {
      if (!webhookToken() || token !== webhookToken()) return { status: 403, body: { error: 'Webhook not authorised' } }
      const incident = clean(body?.metadata?.incident_id ?? body?.incident_id ?? '', 100)
      const rec = (body?.escalation_id && records.get(String(body.escalation_id))) || (incident.startsWith('demo-') ? findByAlertId(incident.slice(5)) : null)
      if (!rec) return { status: 404, body: { error: 'Unknown escalation' } }
      const answer = clean(String(body?.response ?? body?.digit ?? body?.answer ?? ''), 20).toLowerCase()
      const yes = ['1', 'yes', 'y', 'haan', 'हाँ', 'हां', 'escalate'].includes(answer), no = ['2', 'no', 'n', 'nahi', 'नहीं', 'reject'].includes(answer)
      if (!yes && !no) return { status: 400, body: { error: 'response must be 1/yes or 2/no' } }
      const out = await decide(rec.id, yes ? 'escalate' : 'reject', 'call response')
      return { status: out.ok ? 200 : 409, body: { ...out, escalation: view(rec) } }
    },
    stop: () => { stopPoll = true },
    resumePending() { if ([...records.values()].some(r => !TERMINAL.has(expire(r).status))) startPolling() },
  }
}
