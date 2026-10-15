import type { Horizon } from './types'

export type Attempt = { requestId: string; state: 'inflight' | 'unknown' | 'settled' | 'rejected'; horizon?: Horizon; sessionId?: string }
const prefix = 'jn_demo_v1:'
export function readAttempt(key: string): Attempt | null {
  try {
    const raw = sessionStorage.getItem(prefix + key)
    if (!raw) return null
    const value = JSON.parse(raw) as Attempt
    return typeof value.requestId === 'string' && ['inflight', 'unknown', 'settled', 'rejected'].includes(value.state) ? value : null
  } catch { return null }
}
export function writeAttempt(key: string, value: Attempt) {
  try { sessionStorage.setItem(prefix + key, JSON.stringify(value)) }
  catch { throw new Error('Session storage is unavailable. Enable it before approving or creating an exercise so request IDs can survive a reload.') }
}
export const approvalKey = (session: string, alert: string) => `approval:${session}:${alert}`
export const unresolved = (attempt: Attempt | null) => attempt?.state === 'inflight' || attempt?.state === 'unknown'
export const publicUrl = (id: string) => `${window.location.origin}/demo/feed/${encodeURIComponent(id)}`
