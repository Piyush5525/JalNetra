import { API } from '../ops'

/** Client for the API's AWS-powered helpers: Polly speech, Bedrock advisory drafts, Amazon Location walking routes, Rekognition photo checks. */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API + path, { ...init, headers: { 'content-type': 'application/json' } })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error((body && typeof body.error === 'string' && body.error) || `Request failed (${res.status})`)
  return body as T
}

export type Speech = { url: string; voice: string; cached: boolean; characters: number }
export const speak = (text: string, voice: 'Kajal' | 'Aditi' = 'Kajal', lang: 'hi' | 'en' = 'hi') => call<Speech>('/ai/tts', { method: 'POST', body: JSON.stringify({ text, voice, lang }) })

export type Draft = { hi: string; en: string; model: string | null; drafted: boolean }
export const draftAdvisory = (facts: { village: string; district?: string; risk: string; impact: string; shelter: string; km: string; exercise: boolean }) =>
  call<Draft>('/ai/advisory', { method: 'POST', body: JSON.stringify(facts) })

export type Walk = { km: number; minutes: number; path: [number, number][]; steps: { meters: number; minutes: number; direction: string; text: string }[]; source: string }
export const walkingRoute = (from: [number, number], to: [number, number]) => call<Walk>(`/ai/route?from=${from[0].toFixed(5)},${from[1].toFixed(5)}&to=${to[0].toFixed(5)},${to[1].toFixed(5)}`)

export type PhotoVerdict = { verdict: 'likely' | 'possible' | 'unclear'; floodConfidence: number; waterConfidence: number; labels: { name: string; confidence: number }[]; note: string }
export const checkPhoto = (imageBase64: string) => call<PhotoVerdict>('/ai/photo', { method: 'POST', body: JSON.stringify({ imageBase64 }) })

/** English twin of hindiRouteLine. */
export function englishRouteLine(r: { v: string; shelter: string; km: number; ex?: boolean }) {
  const km = r.km < 1 ? `${Math.round(r.km * 1000)} metres` : `${r.km.toFixed(1)} kilometres`
  return `${r.ex ? 'This is an exercise. ' : ''}There is a flood risk in ${r.v}. Safe place: ${r.shelter}, about ${km} away. Please stay calm and reach it by the suggested route.`
}

/** A short Hindi sentence for a route, used for the spoken advisory. */
export function hindiRouteLine(r: { v: string; shelter: string; km: number; ex?: boolean }) {
  const km = r.km < 1 ? `${Math.round(r.km * 1000)} मीटर` : `${r.km.toFixed(1)} किलोमीटर`
  return `${r.ex ? 'यह एक अभ्यास है। ' : ''}${r.v} में बाढ़ का खतरा है। सुरक्षित स्थान: ${r.shelter}, लगभग ${km} दूर। कृपया शांत रहें और सुझाए गए रास्ते से वहाँ पहुँचें।`
}
