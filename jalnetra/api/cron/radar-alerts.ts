/// <reference types="node" />
import process from 'node:process'

type RadarDetection = {
  incident_type?: 'river_flood' | 'waterlogging' | 'pothole' | 'leak'
  severity: 'low' | 'medium' | 'high'
  confidence?: number
  lat: number
  lng: number
  observed_at?: string
  title: string
  evidence_url?: string
  details?: Record<string, unknown>
}

type IncidentResponse = {
  merged: boolean
  incident: { id: string; details?: Record<string, unknown> }
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
})

export default async function handler(req: Request) {
  const secret = process.env.CRON_SECRET
  if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405)
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) return json({ error: 'Unauthorized' }, 401)

  const api = process.env.JALNETRA_API
  const key = process.env.JALNETRA_KEY
  const feedUrl = process.env.RADAR_FEED_URL
  if (!api || !key || !feedUrl) return json({ error: 'JALNETRA_API, JALNETRA_KEY and RADAR_FEED_URL are required' }, 500)

  const feed = await fetch(feedUrl)
  if (!feed.ok) return json({ error: `Radar feed failed (${feed.status})` }, 502)
  const payload = await feed.json() as { detections?: RadarDetection[] }
  const detections = payload.detections ?? []
  const headers = { 'content-type': 'application/json', 'x-jalnetra-key': key }
  const contactIds = (process.env.JALNETRA_ALERT_CONTACT_IDS ?? '').split(',').map(x => x.trim()).filter(Boolean)
  const results: Array<{ title: string; incidentId?: string; merged?: boolean; alert?: unknown }> = []

  for (const detection of detections) {
    const incidentResponse = await fetch(`${api}/incidents`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...detection, incident_type: detection.incident_type ?? 'river_flood', source: 'satellite', language: 'hi' }),
    })
    if (!incidentResponse.ok) return json({ error: `Incident creation failed (${incidentResponse.status})`, results }, 502)
    const created = await incidentResponse.json() as IncidentResponse
    const result: { title: string; incidentId?: string; merged?: boolean; alert?: unknown } = { title: detection.title, incidentId: created.incident.id, merged: created.merged }
    if (!created.merged) {
      if (contactIds.length === 0) {
        result.alert = { status: 'not_sent', reason: 'No approved alert contacts configured' }
      } else {
        const alert = await fetch(`${api}/incidents/${created.incident.id}/alerts`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            contact_ids: contactIds,
            channel: 'call',
            message: `नमस्ते। जलनेत्र की बाढ़ चेतावनी। ${detection.title}। कृपया ऊँची सुरक्षित जगह पर जाएँ और पंचायत को सूचित करें।`,
            context: { place: detection.title, title: detection.title, source: 'Sentinel-1 radar', observed: detection.observed_at ?? new Date().toISOString(), safe_place: 'nearest school or panchayat building on high ground' },
          }),
        })
        result.alert = await alert.json().catch(() => ({ status: alert.status }))
      }
    }
    results.push(result)
  }
  return json({ processed: results.length, results })
}
