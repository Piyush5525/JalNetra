import { API } from '../ops'
import { limitRing, type ZonePolygon } from './zone'

/** WorldPop 100 m constrained population, latest year the stats service has for this region. */
export const POPULATION_YEAR = 2020
/** Mobile phones per person used to turn population into phones (assumption; rural Bihar teledensity is roughly 0.5 to 0.7). */
export const PHONES_PER_PERSON = 0.6
/** Used only while WorldPop is slow or unreachable: Bihar rural average, about 900 people per km2 (WorldPop gave 765 around Harpur). */
export const FALLBACK_DENSITY_PER_KM2 = 900
const MAX_POLYGONS = 4
const MAX_VERTICES = 30

const cache = new Map<string, Promise<number>>()

/** Total population inside the flood-zone polygons, from the WorldPop stats API (through JalNetra's cached proxy). */
export function zonePopulation(polygons: ZonePolygon[]): Promise<number> {
  const features = polygons
    .map(p => ({ p, n: p[0].length }))
    .sort((a, b) => b.n - a.n)
    .slice(0, MAX_POLYGONS)
    .map(({ p }) => {
      const ring = limitRing(p[0], MAX_VERTICES).map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4])
      return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } }
    })
  if (!features.length) return Promise.resolve(0)
  const geojson = JSON.stringify({ type: 'FeatureCollection', features })
  const hit = cache.get(geojson)
  if (hit) return hit
  const req = (async () => {
    const created = await fetch(`${API}/proxy/population?year=${POPULATION_YEAR}&geojson=${encodeURIComponent(geojson)}`)
    if (!created.ok) throw new Error(`Population service unavailable (HTTP ${created.status})`)
    const first = await created.json() as { taskid?: string; data?: { total_population?: number } }
    if (typeof first.data?.total_population === 'number') return Math.round(first.data.total_population)
    if (!first.taskid) throw new Error('Population service returned no task')
    // WorldPop answers in 3 to 50 s: poll the task
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, i < 3 ? 1500 : 2500))
      const r = await fetch(`${API}/proxy/population/task?id=${first.taskid}`)
      if (!r.ok) continue
      const body = await r.json() as { status?: string; error?: boolean; data?: { total_population?: number } }
      if (body.error) throw new Error('Population service reported an error')
      if (body.status === 'finished' && typeof body.data?.total_population === 'number') return Math.round(body.data.total_population)
    }
    throw new Error('Population service timed out')
  })()
  cache.set(geojson, req)
  req.catch(() => cache.delete(geojson))
  return req
}
