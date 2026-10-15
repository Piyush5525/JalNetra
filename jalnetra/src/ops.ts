// Client for the shared JalNetra incident API. The API contract stays the same when the backend moves to AWS.
// The API URL is public; operator keys must never be embedded in the SPA.
// Keep the deployed AWS API as the safe default so a production build made
// without a local .env file cannot silently fall back to the retired Supabase API.
export const API = ((import.meta.env.VITE_JALNETRA_API as string | undefined) || 'https://u51iah4nqf.execute-api.ap-south-1.amazonaws.com').replace(/\/+$/, '')
const getKey = () => { try { return localStorage.getItem('jn_key') || undefined } catch { return undefined } }
export const saveKey = (k: string) => { try { localStorage.setItem('jn_key', k.trim()) } catch { /* storage blocked */ } }
export const clearKey = () => { try { localStorage.removeItem('jn_key') } catch { /* storage blocked */ } }
const CONTACT_PHONE_KEY = 'jn_default_contact_phone'
export const getDefaultContactPhone = () => { try { return localStorage.getItem(CONTACT_PHONE_KEY) || '+91' } catch { return '+91' } }
export const saveDefaultContactPhone = (phone: string) => { try { localStorage.setItem(CONTACT_PHONE_KEY, phone.trim()) } catch { /* storage blocked */ } }

export type Status = 'detected' | 'analyzing' | 'alert_created' | 'approved' | 'contacted' | 'evacuating' | 'resolved' | 'rejected' | 'ticketed' | 'fixed_claimed' | 'verified' | 'reopened' | 'escalated'
export type Incident = {
  id: string; incident_type: 'river_flood' | 'waterlogging' | 'pothole' | 'leak'; severity: 'low' | 'medium' | 'high'; confidence: number
  lat: number; lng: number; observed_at: string; source: string; title: string | null; evidence_url: string | null; details: Record<string, any>
  status: Status; reports: number; reported_by: string; sla_due: string | null; created_at: string; updated_at: string; overdue: boolean
}
export type Event = { id: number; action: string; actor: string; note: string | null; created_at: string }

// Same lifecycle as the API. Floods: detected > analyzing > alert_created > approved > contacted > evacuating > resolved > verified
const FLOOD_NEXT: Record<Status, Status[]> = {
  detected: ['analyzing', 'alert_created', 'rejected'], analyzing: ['alert_created', 'rejected'], alert_created: ['approved', 'rejected', 'escalated'],
  approved: ['contacted', 'rejected', 'escalated'], contacted: ['evacuating', 'resolved', 'escalated'], evacuating: ['resolved', 'escalated'], resolved: ['verified', 'reopened'],
  reopened: ['alert_created', 'escalated'], escalated: ['approved', 'contacted', 'evacuating', 'resolved'], ticketed: [], fixed_claimed: [], rejected: [], verified: [],
}
const CIVIC_NEXT: Record<Status, Status[]> = {
  detected: ['approved', 'rejected'], approved: ['ticketed', 'rejected'], ticketed: ['fixed_claimed', 'escalated'],
  fixed_claimed: ['verified', 'reopened'], reopened: ['ticketed', 'escalated'], escalated: ['ticketed', 'fixed_claimed'], rejected: [], verified: [],
  analyzing: [], alert_created: ['approved', 'rejected'], contacted: [], evacuating: [], resolved: ['verified'],
}
export const NEXT = CIVIC_NEXT
export const nextFor = (i: Incident) => (i.incident_type === 'river_flood' ? FLOOD_NEXT : CIVIC_NEXT)[i.status] ?? []
export const STATUS_LABEL: Record<Status, string> = {
  detected: 'Detected', analyzing: 'Analyzing', alert_created: 'Alert created', approved: 'Operator approved', contacted: 'Sarpanch contacted', evacuating: 'Evacuation initiated', resolved: 'Resolved',
  rejected: 'Rejected', ticketed: 'Ticket raised', fixed_claimed: 'Marked fixed', verified: 'Verified', reopened: 'Reopened', escalated: 'Escalation required',
}
export const ACTION_LABEL: Record<Status, string> = {
  detected: 'Detect', analyzing: 'Start analysis', alert_created: 'Create alert', approved: 'Approve', contacted: 'Mark contacted', evacuating: 'Evacuation started', resolved: 'Mark resolved',
  rejected: 'Reject', ticketed: 'Raise ticket', fixed_claimed: 'Mark fixed', verified: 'Verify', reopened: 'Reopen', escalated: 'Escalate',
}
export const TYPE_LABEL = { river_flood: 'River flood', waterlogging: 'Waterlogging', pothole: 'Pothole', leak: 'Leak' } as const
export const hasKey = () => !!getKey()

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  if (!API) throw new Error('JalNetra API is not configured (set VITE_JALNETRA_API)')
  const KEY = getKey()
  if (!KEY) throw new Error('Add your operator key to connect the dashboard')
  const r = await fetch(API + path, { ...init, headers: { 'content-type': 'application/json', 'x-jalnetra-key': KEY, ...(init?.headers ?? {}) } })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    if (r.status === 401 && j.error === 'Unknown API key') {
      clearKey()
      throw new Error('Operator key rejected by the AWS API. Enter a current operator key and reconnect.')
    }
    throw new Error(j.error ? `${j.error}${j.allowed ? ` (allowed: ${j.allowed.join(', ')})` : ''}` : `Request failed (${r.status})`)
  }
  return j as T
}
export const listIncidents = () => call<{ incidents: Incident[] }>('/incidents?limit=500').then(r => r.incidents)
export const getIncident = (id: string) => call<{ incident: Incident; events: Event[] }>(`/incidents/${id}`)
export const setStatus = (id: string, status: Status, note?: string) => call<{ incident: Incident }>(`/incidents/${id}`, { method: 'PATCH', body: JSON.stringify({ status, note }) })

export type Contact = { id: string; name: string; role: 'sarpanch' | 'asha' | 'ngo' | 'official' | 'volunteer'; phone: string; place_name: string; district: string | null; lat: number; lng: number; km?: number }
export type Alert = { id: string; channel: 'call' | 'sms'; message: string; status: 'sent' | 'failed' | 'not_configured'; error: string | null; created_at: string; jn_contacts: { name: string; role: string; phone: string; place_name: string } | null
  call_status: string | null; summary: string | null; transcript: string | null; questions: string[] | null; outcome: string | null; context: Record<string, unknown> | null }
export const ROLE_LABEL = { sarpanch: 'Sarpanch', asha: 'ASHA worker', ngo: 'NGO', official: 'Official', volunteer: 'Volunteer' } as const
export const listContacts = (lat: number, lng: number, km = 20) => call<{ contacts: Contact[] }>(`/contacts?lat=${lat}&lng=${lng}&km=${km}`).then(r => r.contacts)
export const addContact = (c: Omit<Contact, 'id' | 'km'>) => call<{ contact: Contact }>('/contacts', { method: 'POST', body: JSON.stringify(c) }).then(r => r.contact)
export type Telephony = { call: 'omnidimension' | 'twilio' | 'not_configured'; sms?: 'twilio' | 'not_configured'; demo_phone: string | null }
export type AlertContext = { place: string; title: string; source: string; observed: string; safe_place: string; village?: string; risk?: string; impact_time?: string; route?: string; model_updated?: string; simulated?: boolean }
export const createIncident = (b: Record<string, unknown>) => call<{ merged: boolean; incident: Incident }>('/incidents', { method: 'POST', body: JSON.stringify(b) })
/** Move a flood incident to "approved" through the allowed lifecycle steps. */
export async function approveIncident(i: Incident, note: string) {
  let cur = i
  // The deployed API's lifecycle has no alert_created/analyzing transition;
  // approval is the single operator gate before an alert can be sent.
  const path: Partial<Record<Status, Status>> = { detected: 'approved', reopened: 'approved', escalated: 'approved' }
  for (let k = 0; k < 4 && path[cur.status]; k++) cur = (await setStatus(cur.id, path[cur.status]!, cur.status === 'alert_created' || cur.status === 'escalated' ? note : 'Prediction reviewed')).incident
  return cur
}
export const getTelephony = () => call<Telephony>('/telephony')
export const sendAlerts = (id: string, contact_ids: string[], message: string, channel: 'call' | 'sms', opts: { demo?: boolean; context?: AlertContext } = {}) =>
  call<{ telephony: Telephony['call']; status?: Status; results: { contact: string; phone: string; status: string; error: string | null }[] }>(`/incidents/${id}/alerts`, { method: 'POST', body: JSON.stringify({ contact_ids, message, channel, ...opts }) })
export function alertContext(i: Incident): AlertContext {
  return {
    place: [i.details?.reach, ...(i.details?.villages ?? []).slice(0, 3)].filter(Boolean).join(', ') || `${i.lat.toFixed(3)}, ${i.lng.toFixed(3)}`,
    title: i.title ?? TYPE_LABEL[i.incident_type], source: i.source,
    observed: new Date(i.observed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    safe_place: i.details?.safe_place ?? i.details?.shelter ?? 'nearest school or panchayat building on high ground',
  }
}
export const listAlerts = (id: string) => call<{ alerts: Alert[] }>(`/incidents/${id}/alerts`).then(r => r.alerts)

const HM = ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर']
export function hindiMessage(i: Incident) {
  const d = new Date(i.observed_at), when = `${d.getDate()} ${HM[d.getMonth()]}`
  const places = (i.details?.villages ?? []).slice(0, 3).join(', ')
  if (i.incident_type === 'river_flood') return `नमस्ते। यह जलनेत्र की बाढ़ चेतावनी है। ${when} को उपग्रह ने ${i.details?.reach ?? 'आपके इलाके'} के पास गंडक नदी का पानी गाँवों तक पहुँचते देखा${places ? `, जिनमें ${places} शामिल हैं` : ''}। कृपया बच्चों, बुज़ुर्गों और गर्भवती महिलाओं को सबसे पहले ऊँची सुरक्षित जगह ले जाएँ और पंचायत को सूचित करें।`
  if (i.incident_type === 'waterlogging') return `नमस्ते। यह जलनेत्र की चेतावनी है। आपके पास की सड़क पर गहरा जलभराव है। कृपया उस रास्ते से न जाएँ और बच्चों को पानी से दूर रखें।`
  if (i.incident_type === 'pothole') return `नमस्ते। यह जलनेत्र की सूचना है। आपके इलाके की सड़क पर गड्ढे की शिकायत दर्ज हुई है और मरम्मत के लिए टिकट बनाया गया है।`
  return `नमस्ते। यह जलनेत्र की सूचना है। आपके इलाके की पानी की पाइपलाइन में रिसाव का पता चला है। मरम्मत टीम को सूचित कर दिया गया है।`
}
export function escalationDraft(i: Incident) {
  const hrs = i.sla_due ? Math.max(0, Math.round((Date.now() - Date.parse(i.sla_due)) / 3600e3)) : 0
  const first = new Date(i.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
  return `${i.title ?? 'Reported issue'}. First flagged by JalNetra on ${first} (${i.source}, ${i.reports} report${i.reports > 1 ? 's' : ''}). Still open ${hrs} h past its deadline. Location ${i.lat.toFixed(4)}, ${i.lng.toFixed(4)}. [authority handle]`
}
export type RunSummary = { id: number; created_at: string; mode: string; overall: string; river: string; rain_level: string; at_risk: number; alerts_created: number; error: string | null }
export const listRuns = () => call<{ runs: RunSummary[] }>('/model/runs').then(r => r.runs)
