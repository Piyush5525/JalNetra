import test from 'node:test'
import assert from 'node:assert/strict'
import { createEscalation, citizenMessages } from './escalation.mjs'

const ENV = { ALERT_PHONE_NUMBER1: '+911111111111', ALERT_PHONE_NUMBER2: '+912222222222', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '42', DEMO_TOKEN: 'tok' }
const ids = { sessionId: '11111111-1111-1111-1111-111111111111', alertId: '22222222-2222-2222-2222-222222222222' }

function setup(extra = {}) {
  const calls = [], tg = []
  const dispatch = async (provider, channel, target, message, context, incident) => { calls.push({ target, message, context, incident }); return { status: 'sent', providerRef: 'r', error: null } }
  const fetchFn = async (url, init) => { tg.push({ url, body: JSON.parse(init.body) }); return { json: async () => ({ ok: true, result: { message_id: 7, } }) } }
  let t = 1_000_000
  const svc = createEscalation({ env: { ...ENV, ...extra.env }, dispatch, fetchFn, now: () => t, log() {}, pollMs: 1 })
  return { svc, calls, tg, tick: ms => { t += ms } }
}

test('opening an escalation asks the Sarpanch on Telegram and places no citizen call', async () => {
  const { svc, calls, tg } = setup()
  const v = await svc.open({ ...ids, village: 'Harpur', district: 'Gopalganj', horizonHours: 5 })
  svc.stop()
  assert.equal(v.status, 'awaiting_sarpanch')
  assert.equal(calls.length, 0)
  const send = tg.find(x => x.url.endsWith('/sendMessage'))
  assert.ok(send)
  assert.deepEqual(send.body.reply_markup.inline_keyboard[0].map(b => b.callback_data.split(':')[2]), ['go', 'no'])
})

test('opening is idempotent per alert', async () => {
  const { svc } = setup()
  const a = await svc.open({ ...ids, village: 'Harpur' })
  const b = await svc.open({ ...ids, village: 'Harpur' })
  svc.stop()
  assert.equal(a.id, b.id)
})

test('escalate places exactly one citizen call to number 2 with the citizen message', async () => {
  const { svc, calls } = setup()
  const v = await svc.open({ ...ids, village: 'Harpur', district: 'Gopalganj', horizonHours: 5 })
  const out = await svc.decide(v.id, 'escalate', 'telegram')
  svc.stop()
  assert.equal(out.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].target.phone, '+912222222222')
  assert.match(calls[0].message, /बाढ़ का खतरा/)
  assert.ok(calls[0].message.length < 330, 'one short line, not a long script')
  assert.equal(svc.status(v.id).status, 'escalated')
  // single use: a second press does nothing
  const again = await svc.decide(v.id, 'escalate', 'telegram')
  assert.equal(again.ok, false)
  assert.equal(calls.length, 1)
})

test('reject closes the alert and never calls citizens', async () => {
  const { svc, calls } = setup()
  const v = await svc.open({ ...ids, village: 'Harpur' })
  await svc.decide(v.id, 'reject', 'telegram')
  const late = await svc.decide(v.id, 'escalate', 'telegram')
  svc.stop()
  assert.equal(svc.status(v.id).status, 'rejected')
  assert.equal(late.ok, false)
  assert.equal(calls.length, 0)
})

test('no decision in time expires without escalating', async () => {
  const { svc, calls, tick } = setup()
  const v = await svc.open({ ...ids, village: 'Harpur' })
  tick(21 * 60_000)
  const out = await svc.decide(v.id, 'escalate', 'telegram')
  svc.stop()
  assert.equal(out.ok, false)
  assert.equal(svc.status(v.id).status, 'expired')
  assert.equal(calls.length, 0)
})

test('call webhook needs the token and maps 1/yes and 2/no', async () => {
  const { svc, calls } = setup()
  const v = await svc.open({ ...ids, village: 'Harpur' })
  assert.equal((await svc.callResult({ escalation_id: v.id, response: '1' }, 'wrong')).status, 403)
  assert.equal((await svc.callResult({ escalation_id: v.id, response: 'maybe' }, 'tok')).status, 400)
  const ok = await svc.callResult({ metadata: { incident_id: `demo-${ids.alertId}` }, response: 'yes' }, 'tok')
  svc.stop()
  assert.equal(ok.status, 200)
  assert.equal(calls.length, 1)
})

test('citizen message is one short urgent line with the hours and the shelter', () => {
  const m = citizenMessages({ village: 'Harpur', hours: 5, shelter: 'K.R. High School' })
  assert.match(m.hi, /5 घंटे/)
  assert.match(m.hi, /K\.R\. High School/)
  assert.match(m.en, /arrive in about 5 hours/)
  assert.ok(m.hi.length + m.en.length < 330)
})

test('a busy line (concurrency limit) is retried until the Sarpanch call has ended', async () => {
  const calls = []
  let n = 0
  const dispatch = async (p, c, target) => { calls.push(target.phone); n++; return n < 3 ? { status: 'failed', providerRef: null, error: 'concurrency_limit_exceeded' } : { status: 'sent', providerRef: 'r', error: null } }
  const fetchFn = async () => ({ json: async () => ({ ok: true, result: { message_id: 1 } }) })
  const svc = createEscalation({ env: ENV, dispatch, fetchFn, log() {}, pollMs: 1, retryMs: 5 })
  const v = await svc.open({ ...ids, village: 'Harpur' })
  const out = await svc.decide(v.id, 'escalate', 'telegram')
  assert.equal(out.ok, true)
  assert.equal(svc.status(v.id).status, 'escalating')
  await new Promise(r => setTimeout(r, 120))
  svc.stop()
  assert.equal(svc.status(v.id).status, 'escalated')
  assert.equal(calls.length, 3)
})

test('the IVR answer extracted by the provider is used when it arrives', async () => {
  const calls = []
  const dispatch = async (p, c, target) => { calls.push(target.phone); return { status: 'sent', providerRef: 'r', error: null } }
  const fetchFn = async url => String(url).includes('/calls/logs')
    ? { ok: true, json: async () => ({ call_log_data: [{ id: 5, call_request_id: { id: 777 }, call_status: 'completed', extracted_variables: { decision: 'escalate' } }] }) }
    : { json: async () => ({ ok: true, result: { message_id: 1 } }) }
  const svc = createEscalation({ env: { ...ENV, OMNIDIM_API_KEY: 'k', OMNIDIM_SARPANCH_AGENT_ID: '270691' }, dispatch, fetchFn, log() {}, pollMs: 1, callPollMs: 5, retryMs: 5, requestIdFor: () => 777 })
  const v = await svc.open({ ...ids, village: 'Harpur' })
  await new Promise(r => setTimeout(r, 150))
  svc.stop()
  assert.equal(svc.status(v.id).status, 'escalated')
  assert.equal(svc.status(v.id).decidedVia, 'the call')
  assert.deepEqual(calls, ['+912222222222'])
})

test('Telegram is told about a decision made on the call, and the buttons are removed', async () => {
  const sent = []
  const dispatch = async () => ({ status: 'sent', providerRef: 'r', error: null })
  const fetchFn = async (url, init) => {
    if (String(url).includes('api.telegram.org')) { sent.push({ m: String(url).split('/').pop(), b: JSON.parse(init.body) }); return { json: async () => ({ ok: true, result: { message_id: 3 } }) } }
    return { ok: true, json: async () => ({ call_log_data: [{ id: 1, call_request_id: { id: 9 }, call_status: 'completed', extracted_variables: { decision: 'reject' } }] }) }
  }
  const svc = createEscalation({ env: { ...ENV, OMNIDIM_API_KEY: 'k' }, dispatch, fetchFn, log() {}, pollMs: 1, callPollMs: 5, requestIdFor: () => 9 })
  const v = await svc.open({ ...ids, village: 'Harpur' })
  await new Promise(r => setTimeout(r, 120))
  svc.stop()
  assert.equal(svc.status(v.id).status, 'rejected')
  assert.ok(sent.some(x => x.m === 'editMessageReplyMarkup' && x.b.reply_markup.inline_keyboard.length === 0))
  assert.ok(sent.some(x => x.m === 'sendMessage' && /false alarm/.test(x.b.text) && /the call/.test(x.b.text)))
})

test('"two" is recorded as heard-the-message and does not decide', async () => {
  const dispatch = async () => ({ status: 'sent', providerRef: 'r', error: null })
  const fetchFn = async url => String(url).includes('api.telegram.org')
    ? { json: async () => ({ ok: true, result: { message_id: 3 } }) }
    : { ok: true, json: async () => ({ call_log_data: [{ id: 1, call_request_id: { id: 9 }, call_status: 'completed', extracted_variables: { decision: 'acknowledged' } }] }) }
  const svc = createEscalation({ env: { ...ENV, OMNIDIM_API_KEY: 'k' }, dispatch, fetchFn, log() {}, pollMs: 1, callPollMs: 5, requestIdFor: () => 9 })
  const v = await svc.open({ ...ids, village: 'Harpur' })
  await new Promise(r => setTimeout(r, 80))
  svc.stop()
  const s = svc.status(v.id)
  assert.equal(s.status, 'awaiting_sarpanch')
  assert.equal(s.acknowledged, true)
})
