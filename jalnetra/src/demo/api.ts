import { API } from '../ops'
import type { DemoAlert, DemoApprovalResult, DemoPredictionReference, DemoSession, Horizon, PublicDemoFeed } from './types'

export const SCENARIO = 'gandak-exercise-v1'
export const MODEL = '2026.10-a'
export const CLOCK = '2026-09-27T06:00:00Z'
export const VILLAGES = [10820949, 10817005, 10820612, 10825537, 10826242]
const horizons = [0, 3, 6, 12, 24]
export class DemoApiError extends Error {
  status: number
  code: string
  retryAfterSeconds: number
  ambiguous: boolean
  constructor(message: string, status = 0, code = 'NETWORK_ERROR', retryAfterSeconds = 0, ambiguous = false) {
    super(message); this.status = status; this.code = code; this.retryAfterSeconds = retryAfterSeconds; this.ambiguous = ambiguous
  }
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const date = (v: unknown) => text(v) && Number.isFinite(Date.parse(v))
function prediction(v: unknown, approved: boolean): v is DemoPredictionReference {
  return object(v) && /^gandak-ex-[1-5]$/.test(String(v.scenarioId)) && v.scenarioVersion === SCENARIO && v.modelVersion === MODEL &&
    v.simulatedClock === CLOCK && v.dataBasis === 'synthetic_replay' && VILLAGES.includes(v.villageId as number) &&
    text(v.villageName) && text(v.district) && typeof v.lat === 'number' && Number.isFinite(v.lat) &&
    typeof v.lng === 'number' && Number.isFinite(v.lng) &&
    (approved ? horizons.includes(v.horizonHours as number) && (v.predictionDigest === null || /^[a-f0-9]{64}$/i.test(String(v.predictionDigest))) : v.horizonHours === null || horizons.includes(v.horizonHours as number))
}
function alert(v: unknown): v is DemoAlert {
  return object(v) && text(v.id) && [1, 2, 3, 4, 5].includes(v.order as number) && v.exercise === true && text(v.title) &&
    text(v.messageHi) && text(v.messageEn) && ['pending', 'approved'].includes(v.approvalStatus as string) &&
    prediction(v.prediction, v.approvalStatus === 'approved') &&
    ['not_requested', 'dispatching', 'dispatched', 'failed', 'not_configured', 'unknown'].includes(v.callStatus as string) &&
    [0, 1].includes(v.callAttempts as number) && (v.approvalStatus !== 'approved' || date(v.approvedAt))
}
function allowance(v: unknown): boolean {
  return object(v) && Number.isInteger(v.callsUsed) && (v.callsUsed as number) >= 0 && v.callsMax === 3 &&
    (v.callsUsed as number) <= 3 && typeof v.cooldownSeconds === 'number' && v.cooldownSeconds >= 0 &&
    (v.nextCallAllowedAt === null || date(v.nextCallAllowedAt))
}
export function validateSession(v: unknown): DemoSession {
  if (!object(v) || !text(v.id) || v.exercise !== true || v.scenarioVersion !== SCENARIO || !date(v.createdAt) || !text(v.createdBy) ||
    !object(v.demoDestination) || typeof v.demoDestination.configured !== 'boolean' ||
    !(v.demoDestination.masked === null || typeof v.demoDestination.masked === 'string') ||
    !['omnidimension', 'twilio', 'not_configured'].includes(v.demoDestination.provider as string) || !allowance(v.allowance) ||
    !Array.isArray(v.alerts) || v.alerts.length !== 5 || !v.alerts.every(alert) ||
    new Set(v.alerts.map(a => a.id)).size !== 5 || new Set(v.alerts.map(a => a.order)).size !== 5 ||
    new Set(v.alerts.map(a => a.prediction.villageId)).size !== 5) throw new DemoApiError('The server returned an invalid exercise session. Refresh to reconcile; approval is unavailable.', 0, 'INVALID_RESPONSE', 0, true)
  return v as unknown as DemoSession
}
export function validatePublicFeed(v: unknown): PublicDemoFeed {
  if (!object(v) || v.exercise !== true || v.banner !== 'EXERCISE / अभ्यास: not a real flood warning' || !text(v.sessionId) || !date(v.generatedAt) ||
    !Array.isArray(v.items) || v.items.length > 5 || !v.items.every(i => object(i) && text(i.id) && text(i.title) &&
      [1, 2, 3, 4, 5].includes(i.order as number) && text(i.messageHi) && text(i.messageEn) && date(i.approvedAt) &&
      prediction(i.prediction, true) && ['dispatched', 'not_confirmed'].includes(i.demoCall as string)) ||
    new Set(v.items.map(i => i.id)).size !== v.items.length) throw new DemoApiError('This response is not a valid approved exercise feed.', 0, 'INVALID_RESPONSE')
  return v as unknown as PublicDemoFeed
}

async function request(path: string, options: { body?: unknown; signal?: AbortSignal; anonymous?: boolean } = {}): Promise<unknown> {
  const mutation = options.body !== undefined
  const headers: Record<string, string> = { Accept: 'application/json' }
  // No operator key is needed: exercise routes run in public exercise mode on the server, which only ever calls the configured demo phone.
  if (mutation) headers['Content-Type'] = 'application/json'
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (options.signal?.aborted) controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, 15000)
  try {
    const response = await fetch(API + path, { method: mutation ? 'POST' : 'GET', headers, credentials: 'omit', cache: 'no-store', signal: controller.signal, ...(mutation ? { body: JSON.stringify(options.body) } : {}) })
    const body: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const seconds = response.headers.get('Retry-After')
      const fromHeader = seconds ? (/^\d+$/.test(seconds) ? Number(seconds) : Math.max(0, Math.ceil((Date.parse(seconds) - Date.now()) / 1000))) : 0
      const fromBody = object(body) && object(body.details) && typeof body.details.retryAfterSeconds === 'number' ? body.details.retryAfterSeconds : 0
      let message = object(body) && text(body.error) ? body.error : `Request failed (${response.status}).`
      if (response.status === 404) message = 'Exercise endpoint or session not found. The demo backend may not be deployed; ask the administrator to deploy /demo, or check the session link.'
      if (response.status === 401) message = 'The exercise service refused the request (not authorised). Public exercise mode may be switched off on the server.'
      if (response.status === 403) message = 'This exercise session belongs to a different operator. A new one will be created.'
      throw new DemoApiError(message, response.status, object(body) && text(body.code) ? body.code : 'API_ERROR', Math.max(Number.isFinite(fromHeader) ? fromHeader : 0, fromBody, response.status === 429 ? 1 : 0), mutation && response.status >= 500)
    }
    return body
  } catch (error) {
    if (error instanceof DemoApiError) throw error
    if (options.signal?.aborted) throw new DOMException('Read cancelled', 'AbortError')
    throw new DemoApiError(controller.signal.aborted ? 'Request timed out. The server outcome has not been confirmed.' : 'Connection failed. The server outcome has not been confirmed.', 0, 'NETWORK_ERROR', 0, mutation)
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}
export const createSession = async (requestId: string) => validateSession(await request('/demo/sessions', { body: { requestId } }))
export async function getSession(id: string, signal?: AbortSignal) {
  const session = validateSession(await request(`/demo/sessions/${encodeURIComponent(id)}`, { signal }))
  if (session.id !== id) throw new DemoApiError('Session identity mismatch. Approval is unavailable.', 0, 'INVALID_RESPONSE')
  return session
}
export async function approveAlert(sessionId: string, alertId: string, requestId: string, forecastHorizonHours: Horizon, spoken?: { hi: string; en: string }): Promise<DemoApprovalResult> {
  const result = await request(`/demo/sessions/${encodeURIComponent(sessionId)}/alerts/${encodeURIComponent(alertId)}/approve`, { body: { requestId, forecastHorizonHours, ...(spoken ? { callMessageHi: spoken.hi, callMessageEn: spoken.en } : {}) } })
  if (!object(result) || typeof result.replayed !== 'boolean' || !alert(result.alert) || result.alert.id !== alertId || result.alert.approvalStatus !== 'approved' || result.alert.prediction.horizonHours !== forecastHorizonHours || !object(result.session) || !allowance(result.session.allowance)) throw new DemoApiError('Approval response could not be verified. Reconcile this session before proceeding.', 0, 'INVALID_RESPONSE', 0, true)
  return result as unknown as DemoApprovalResult
}
export async function getPublicFeed(id: string, signal?: AbortSignal) {
  const feed = validatePublicFeed(await request(`/demo/public/${encodeURIComponent(id)}`, { anonymous: true, signal }))
  if (feed.sessionId !== id) throw new DemoApiError('Public feed identity mismatch.', 0, 'INVALID_RESPONSE')
  return feed
}
