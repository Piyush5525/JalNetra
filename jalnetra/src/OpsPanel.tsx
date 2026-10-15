import { useEffect, useMemo, useState } from 'react'
import { FiAlertTriangle, FiRefreshCw, FiArrowLeft, FiClock, FiPhoneCall, FiVolume2, FiCopy, FiPlus } from 'react-icons/fi'
import { ACTION_LABEL, NEXT, ROLE_LABEL, STATUS_LABEL, TYPE_LABEL, addContact, escalationDraft, getIncident, hasKey, hindiMessage, listAlerts, getTelephony, alertContext, type Telephony, listContacts, listIncidents, saveKey, sendAlerts, setStatus, getDefaultContactPhone, saveDefaultContactPhone, type Alert, type Contact, type Event, type Incident, type Status } from './ops'
import { FloodSpreadPanel, type Horizon } from './floodSpread'

const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000)
  return m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}
const slaText = (i: Incident) => {
  if (!i.sla_due || ['verified', 'rejected'].includes(i.status)) return null
  const h = (Date.parse(i.sla_due) - Date.now()) / 3600e3
  return h < 0 ? `SLA missed by ${Math.abs(h).toFixed(0)} h` : `${h.toFixed(0)} h left on SLA`
}
const OPEN: Status[] = ['detected', 'approved', 'ticketed', 'reopened', 'escalated', 'fixed_claimed']

export function useIncidents() {
  const [items, setItems] = useState<Incident[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const load = async () => {
    setLoading(true)
    try { setItems(await listIncidents()); setErr(null) } catch (e) { setErr((e as Error).message) } finally { setLoading(false) }
  }
  useEffect(() => { load(); const id = setInterval(load, 15000); return () => clearInterval(id) }, [])
  return { items, err, loading, load, setItems }
}

export default function OpsPanel({ inc, selId, onSelect, onBack, onViewFloodSpread }: { inc: ReturnType<typeof useIncidents>; selId: string | null; onSelect: (i: Incident | null) => void; onBack: () => void; onViewFloodSpread?: (horizon: Horizon | null) => void }) {
  const [filter, setFilter] = useState<'open' | 'all' | 'overdue'>('open')
  const [detail, setDetail] = useState<{ incident: Incident; events: Event[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [actErr, setActErr] = useState<string | null>(null)
  const [showSpread, setShowSpread] = useState(false)
  const shown = useMemo(() => inc.items.filter(i => filter === 'all' ? true : filter === 'overdue' ? i.overdue : OPEN.includes(i.status)), [inc.items, filter])
  const counts = useMemo(() => ({ open: inc.items.filter(i => OPEN.includes(i.status)).length, overdue: inc.items.filter(i => i.overdue).length, all: inc.items.length }), [inc.items])

  useEffect(() => { setShowSpread(false); if (!selId) { setDetail(null); return } getIncident(selId).then(setDetail).catch(e => setActErr(e.message)) }, [selId])
  const act = async (s: Status) => {
    if (!detail) return
    setBusy(true); setActErr(null)
    try {
      await setStatus(detail.incident.id, s, note || undefined); setNote('')
      setDetail(await getIncident(detail.incident.id)); inc.load()
    } catch (e) { setActErr((e as Error).message) } finally { setBusy(false) }
  }

  const [keyIn, setKeyIn] = useState('')
  if (!hasKey()) return (
    <aside className="panel"><section>
      <div className="kicker">Operator access</div><div className="h">Connect your dashboard</div>
      <p className="note">This private code is only for the JalNetra operator. Visitors do not need it. It stays in this browser.</p>
      <label htmlFor="ops-key" className="kicker mt">Operator access code</label>
      <input id="ops-key" className="note-in" type="password" autoComplete="off" placeholder="Enter your private code" value={keyIn} onChange={e => setKeyIn(e.target.value)} />
      <div className="acts"><button disabled={!keyIn.trim()} onClick={() => { saveKey(keyIn); inc.load() }}>Connect operator dashboard</button><button className="ghost" onClick={onBack}><FiArrowLeft /> Back to public site</button></div>
    </section></aside>
  )

  if (detail) {
    const i = detail.incident, sla = slaText(i)
    return (
      <aside className="panel">
        <section>
          <button className="link back" onClick={() => onSelect(null)}><FiArrowLeft /> All incidents</button>
          <div className="incident-summary">
            <div className="kicker">{TYPE_LABEL[i.incident_type]} · {i.severity} severity · {i.source}</div>
            <div className="h">{i.title ?? `${TYPE_LABEL[i.incident_type]} report`}</div>
            <div className="pills"><span className={'pill st-' + i.status}>{STATUS_LABEL[i.status]}</span>{sla && <span className={'pill ' + (i.overdue ? 'atrisk' : 'safe')}><FiClock /> {sla}</span>}</div>
          </div>
          <dl className="kv incident-facts">
            <dt>Observed</dt><dd>{new Date(i.observed_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })} IST</dd>
            <dt>Location</dt><dd>{i.lat.toFixed(4)}, {i.lng.toFixed(4)}</dd>
            <dt>Reports</dt><dd>{i.reports} · first from {i.reported_by}</dd>
            <dt>Confidence</dt><dd>{Math.round(i.confidence * 100)}%</dd>
            {i.details?.districts?.length > 0 && <><dt>Districts</dt><dd>{i.details.districts.join(', ')}</dd></>}
            {i.details?.villages?.length > 0 && <><dt>Villages</dt><dd>{i.details.villages.slice(0, 12).join(', ')}{i.details.villages.length > 12 ? ` and ${i.details.villages.length - 12} more` : ''}</dd></>}
          </dl>
          {NEXT[i.status].length > 0 && (
            <div className="action-panel">
              <div className="kicker mt">Next action</div>
              <input id="ops-note" className="note-in" placeholder="Note for the record (optional)" value={note} onChange={e => setNote(e.target.value)} />
              <div className="acts">{NEXT[i.status].map(s => <button key={s} disabled={busy} className={s === 'rejected' || s === 'reopened' || s === 'escalated' ? 'ghost' : ''} onClick={() => act(s)}>{ACTION_LABEL[s]}</button>)}</div>
            </div>
          )}
          {i.incident_type === 'river_flood' && ['approved', 'ticketed', 'contacted', 'evacuating'].includes(i.status) && <>
            <button className="link" onClick={() => setShowSpread(value => { const next = !value; onViewFloodSpread?.(next ? 24 : null); return next })}>{showSpread ? 'Hide flood spread' : 'View flood spread'}</button>
            {showSpread && <FloodSpreadPanel onHorizonChange={onViewFloodSpread ?? undefined} />}
          </>}
          {actErr && <p className="err">{actErr}</p>}
          <WarnBlock i={i} />
          {i.overdue && <Escalation i={i} />}
          <div className="kicker mt">History</div>
          <ol className="tl">{detail.events.map(e => <li key={e.id}><b>{STATUS_LABEL[e.action as Status] ?? ({ evidence: 'Evidence', alert: 'Warning sent', duplicate_report: 'Another report' } as Record<string, string>)[e.action] ?? e.action.replace('_', ' ')}</b> · {e.actor} · {ago(e.created_at)}{e.note ? <div className="tlnote">{e.note}</div> : null}</li>)}</ol>
        </section>
      </aside>
    )
  }

  return (
    <aside className="panel">
      <section>
        <div className="vhead"><div><div className="kicker">Operations · live from the shared API</div><div className="h">Incidents</div></div>
          <button className="x" onClick={inc.load} aria-label="Refresh"><FiRefreshCw className={inc.loading ? 'spin' : ''} /></button></div>
        <div className="seg sm">{(['open', 'overdue', 'all'] as const).map(f => <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f === 'open' ? `Open ${counts.open}` : f === 'overdue' ? `Overdue ${counts.overdue}` : `All ${counts.all}`}</button>)}</div>
        {inc.err && <p className="err"><FiAlertTriangle /> {inc.err}</p>}
        <ul className="ilist">
          {shown.map(i => (
            <li key={i.id}><button onClick={() => onSelect(i)}>
              <span className={'dot sev-' + i.severity} />
              <span className="it"><span className="ititle">{i.title ?? TYPE_LABEL[i.incident_type]}</span>
                <span className="imeta">{TYPE_LABEL[i.incident_type]} · {STATUS_LABEL[i.status]} · {ago(i.created_at)}{i.overdue ? ' · SLA missed' : ''}</span></span>
            </button></li>
          ))}
          {shown.length === 0 && !inc.err && <li className="empty">No incidents in this view.</li>}
        </ul>
        <button className="link" onClick={onBack}><FiArrowLeft /> Back to the flood map</button>
      </section>
    </aside>
  )
}

function WarnBlock({ i }: { i: Incident }) {
  const APPROVED_STATUSES: Status[] = ['approved', 'ticketed', 'contacted', 'evacuating']
  const [contacts, setContacts] = useState<Contact[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [msg, setMsg] = useState(hindiMessage(i))
  const [channel] = useState<'call'>('call')
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [res, setRes] = useState<{ call?: string; sms?: string; error?: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [tel, setTel] = useState<Telephony | null>(null)
  const [demo, setDemo] = useState(false)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', role: 'sarpanch' as Contact['role'], phone: getDefaultContactPhone(), place_name: (i.details?.villages ?? [])[0] ?? '' })
  const load = () => {
    listContacts(i.lat, i.lng, 25).then(found => {
      setContacts(found)
      const existingPhone = found[0]?.phone
      if (existingPhone && getDefaultContactPhone() === '+91') { saveDefaultContactPhone(existingPhone); setForm(f => ({ ...f, phone: existingPhone })) }
    }).catch(() => {})
    listAlerts(i.id).then(setAlerts).catch(() => {})
  }
  useEffect(() => { setMsg(hindiMessage(i)); setPicked([]); setRes(null); load() }, [i.id])
  useEffect(() => { getTelephony().then(setTel).catch(() => {}) }, [])
  const resultText = (label: string, r: Awaited<ReturnType<typeof sendAlerts>>) => {
    const sent = r.results.filter(x => x.status === 'sent').length
    const via = r.telephony === 'omnidimension' ? (sent ? `OmniDimension dispatched ${sent} Hindi AI call${sent === 1 ? '' : 's'}` : 'OmniDimension dispatch failed') : r.telephony === 'twilio' ? (sent ? `Twilio dispatched ${sent} SMS${sent === 1 ? '' : 'es'}` : 'Twilio dispatch failed') : 'No phone provider is configured; nothing was placed'
    return `${label}: ${via}. ${r.results.map(x => `${x.contact}: ${x.status === 'sent' ? 'sent' : x.status}${x.error ? ` (${x.error})` : ''}`).join(' · ')}`
  }
  const send = async () => {
    if (!APPROVED_STATUSES.includes(i.status)) return
    setBusy(true); setRes(null)
    const context = alertContext(i)
    const next: { call?: string; sms?: string; error?: string } = {}
    try {
      if (channel === 'call' || channel === 'both') {
        try {
          const call = await sendAlerts(i.id, picked, msg, 'call', { demo, context })
          next.call = resultText('Hindi voice call', call)
        } catch (e) {
          next.call = `Hindi voice call: ${(e as Error).message}`
          setRes({ ...next })
          return
        }
      }
      setRes(next)
      load()
    } finally { setBusy(false) }
  }
  const save = async () => {
    setBusy(true); setRes(null)
    try { await addContact({ ...form, district: (i.details?.districts ?? [])[0] ?? null, lat: i.lat, lng: i.lng, language: 'hi' } as any); saveDefaultContactPhone(form.phone); setAdding(false); setForm({ ...form, name: '', phone: form.phone }); load() } catch (e) { setRes({ error: (e as Error).message }) } finally { setBusy(false) }
  }
  const preview = () => { try { const u = new SpeechSynthesisUtterance(msg); u.lang = 'hi-IN'; speechSynthesis.cancel(); speechSynthesis.speak(u) } catch { /* no speech */ } }
  return (
    <div className="alert-panel">
      <div className="alert-heading"><div className="kicker">Operator alert</div><div className="h">Warn people nearby</div><p className="note">Review the contacts and message, then place the Hindi voice call.</p></div>
      {contacts.length === 0 ? <p className="note">No contacts within 25 km yet. Add the sarpanch, ASHA worker or NGO for this area.</p> : (
        <ul className="clist">{contacts.map(c => (
          <li key={c.id}><label><input type="checkbox" checked={picked.includes(c.id)} onChange={e => setPicked(p => e.target.checked ? [...p, c.id] : p.filter(x => x !== c.id))} />
            <span><b>{c.name}</b> · {ROLE_LABEL[c.role]}, {c.place_name}<span className="imeta"> {c.phone} · {c.km?.toFixed(1)} km</span></span></label></li>
        ))}</ul>
      )}
      {adding ? (
        <div className="cform">
          <input id="c-name" className="note-in" placeholder="Name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
          <select id="c-role" className="note-in" value={form.role} onChange={e => setForm({ ...form, role: e.target.value as Contact['role'] })}>{Object.entries(ROLE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <input id="c-phone" className="note-in" placeholder="+91XXXXXXXXXX" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} />
          <input id="c-place" className="note-in" placeholder="Village or place" value={form.place_name} onChange={e => setForm({ ...form, place_name: e.target.value })} />
          <div className="acts"><button disabled={busy || !form.name || form.phone.length < 10 || !form.place_name} onClick={save}>Save contact</button><button className="ghost" onClick={() => setAdding(false)}>Cancel</button></div>
        </div>
      ) : <button className="link back" onClick={() => setAdding(true)}><FiPlus /> Add contact</button>}
      {tel?.demo_phone && <label className="demo-row"><input type="checkbox" checked={demo} onChange={e => setDemo(e.target.checked)} /> <span>Also call demo phone <span className="imeta">{tel.demo_phone}</span></span></label>}
      {tel && <p className="imeta">Voice calls: {tel.call === 'omnidimension' ? 'OmniDimension Hindi agent configured' : tel.call === 'twilio' ? 'Twilio voice configured' : 'not connected'}</p>}
      {!APPROVED_STATUSES.includes(i.status) && <p className="note">Approve this incident before sending an alert.</p>}
      {APPROVED_STATUSES.includes(i.status) && contacts.length === 0 && <p className="note">This incident is approved, but no phone contact is available. Add and select a sarpanch or responder before sending.</p>}
      <label className="kicker mt" htmlFor="warn-msg">Message for selected contacts</label>
      <textarea id="warn-msg" className="note-in msg" rows={5} value={msg} onChange={e => setMsg(e.target.value)} />
      <div className="acts alert-actions">
        <div className="seg sm inline channel-picker" aria-label="Alert channel"><button className="on">Voice call</button></div>
        <button className="ghost" onClick={preview}><FiVolume2 /> Preview</button>
        <button className="primary-action" disabled={busy || !APPROVED_STATUSES.includes(i.status) || (picked.length === 0 && !demo) || !msg.trim()} onClick={send}><FiPhoneCall /> {busy ? 'Calling…' : 'Place Hindi voice call'}</button>
      </div>
      {res && <div className="send-results" aria-live="polite">{res.error && <p className="note"><b>Error</b> · {res.error}</p>}{res.call && <p className="note"><b>Voice call</b> · {res.call.replace('Hindi voice call: ', '')}</p>}{res.sms && <p className="note"><b>SMS</b> · {res.sms.replace('SMS: ', '')}</p>}</div>}
      {alerts.length > 0 && <div className="history"><div className="kicker">Recent alert history</div><ul className="tl">{alerts.slice(0, 6).map(a => <li key={a.id}><b>{a.channel === 'call' ? 'Call' : 'SMS'} · {a.status === 'sent' ? 'sent' : a.status === 'failed' ? 'failed' : 'logged, not connected'}</b> · {a.jn_contacts?.name ?? 'Demo phone'} · {new Date(a.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</li>)}</ul></div>}
    </div>
  )
}

function Escalation({ i }: { i: Incident }) {
  const [text, setText] = useState(escalationDraft(i))
  const [copied, setCopied] = useState(false)
  const copy = async () => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch { /* clipboard blocked */ } }
  return (
    <>
      <div className="kicker mt">Deadline missed · public escalation draft</div>
      <p className="note">Nothing is posted automatically. Check the facts, add the authority&apos;s handle, then copy.</p>
      <textarea id="esc-msg" className="note-in msg" rows={4} value={text} onChange={e => setText(e.target.value)} maxLength={280} />
      <div className="acts"><span className="imeta">{text.length}/280</span><button onClick={copy}><FiCopy /> {copied ? 'Copied' : 'Copy post'}</button></div>
    </>
  )
}
