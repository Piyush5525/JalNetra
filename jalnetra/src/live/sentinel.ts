import { useEffect, useState } from 'react'

/**
 * Live Sentinel imagery from Microsoft's Planetary Computer (free, no key): Sentinel-1 radar (RTC, VV) for flood water and
 * Sentinel-2 L2A for the true-colour picture. A mosaic is registered over the Gandak area, newest scene first, and drawn as map
 * tiles. The newest acquisition date is read from the STAC catalogue so the page can say how fresh the picture is.
 */
const PC = 'https://planetarycomputer.microsoft.com/api'
const AREA = [[83.1, 25.5], [85.65, 25.5], [85.65, 28.45], [83.1, 28.45], [83.1, 25.5]]
const BBOX = [83.1, 25.5, 85.65, 28.45]

export type SentinelLayer = { tiles: string; when: string; scene: string }

const day = (n: number) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10) + 'T00:00:00Z'

async function newest(collection: string, days: number, extra?: object): Promise<{ id: string; datetime: string } | null> {
  const res = await fetch(`${PC}/stac/v1/search`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ collections: [collection], bbox: BBOX, datetime: `${day(days)}/..`, limit: 1, sortby: [{ field: 'datetime', direction: 'desc' }], ...extra }),
  })
  if (!res.ok) return null
  const f = ((await res.json()) as { features?: { id: string; properties: { datetime: string } }[] }).features?.[0]
  return f ? { id: f.id, datetime: f.properties.datetime } : null
}

async function mosaic(collection: string, since: string, extra: object[] = []): Promise<string | null> {
  const res = await fetch(`${PC}/data/v1/mosaic/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      'filter-lang': 'cql2-json',
      filter: { op: 'and', args: [
        { op: '=', args: [{ property: 'collection' }, collection] },
        { op: 's_intersects', args: [{ property: 'geometry' }, { type: 'Polygon', coordinates: [AREA] }] },
        { op: '>=', args: [{ property: 'datetime' }, since] },
        ...extra,
      ] },
      sortby: [{ field: 'datetime', direction: 'desc' }],
      metadata: { name: `jalnetra-${collection}` },
    }),
  })
  if (!res.ok) return null
  return ((await res.json()) as { searchid?: string }).searchid ?? null
}

async function sentinel1(): Promise<SentinelLayer | null> {
  const n = await newest('sentinel-1-rtc', 30)
  if (!n) return null
  const since = new Date(Date.parse(n.datetime) - 6 * 864e5).toISOString()
  const id = await mosaic('sentinel-1-rtc', since)
  if (!id) return null
  return { tiles: `${PC}/data/v1/mosaic/${id}/tiles/WebMercatorQuad/{z}/{x}/{y}@1x?collection=sentinel-1-rtc&assets=vv&rescale=0,0.25&format=png`, when: n.datetime, scene: n.id }
}

async function sentinel2(): Promise<SentinelLayer | null> {
  const n = await newest('sentinel-2-l2a', 45, { query: { 'eo:cloud_cover': { lt: 30 } } })
  if (!n) return null
  const since = new Date(Date.parse(n.datetime) - 20 * 864e5).toISOString()
  const id = await mosaic('sentinel-2-l2a', since, [{ op: '<', args: [{ property: 'eo:cloud_cover' }, 30] }])
  if (!id) return null
  return { tiles: `${PC}/data/v1/mosaic/${id}/tiles/WebMercatorQuad/{z}/{x}/{y}@1x?collection=sentinel-2-l2a&assets=B04&assets=B03&assets=B02&rescale=0,3000&format=png`, when: n.datetime, scene: n.id }
}

let cache: Promise<{ s1: SentinelLayer | null; s2: SentinelLayer | null }> | null = null
let cachedAt = 0

/** Newest Sentinel-1 flood and Sentinel-2 true-colour layers. Null for a layer means the catalogue could not be reached. */
export function useSentinel(enabled: boolean) {
  const [state, setState] = useState<{ s1: SentinelLayer | null; s2: SentinelLayer | null; loading: boolean }>({ s1: null, s2: null, loading: enabled })
  useEffect(() => {
    if (!enabled) return
    let alive = true
    if (!cache || Date.now() - cachedAt > 6 * 3600e3) {
      cachedAt = Date.now()
      cache = Promise.all([sentinel1().catch(() => null), sentinel2().catch(() => null)]).then(([s1, s2]) => ({ s1, s2 }))
    }
    cache.then(r => { if (alive) setState({ ...r, loading: false }) })
    return () => { alive = false }
  }, [enabled])
  return state
}

/**
 * One Sentinel-1 tile to a transparent picture with only the water drawn. Open water is a mirror to radar, so VV backscatter is
 * very low (here below about 0.025 of the 0..0.25 scale). Bright pixels (land, buildings) are dropped.
 */
export async function floodTile(url: string, signal?: AbortSignal): Promise<ImageBitmap | null> {
  const res = await fetch(url, { signal })
  if (!res.ok) return null
  const bmp = await createImageBitmap(await res.blob())
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height
  const g = c.getContext('2d', { willReadFrequently: true })!
  g.drawImage(bmp, 0, 0)
  const img = g.getImageData(0, 0, c.width, c.height), d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const water = d[i + 3] > 200 && d[i] < 26
    d[i] = 40; d[i + 1] = 130; d[i + 2] = 245; d[i + 3] = water ? 190 : 0
  }
  g.putImageData(img, 0, 0)
  return await createImageBitmap(c)
}
