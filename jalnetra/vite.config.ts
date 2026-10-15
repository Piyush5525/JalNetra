import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { networkInterfaces } from 'node:os'
import { randomBytes } from 'node:crypto'
import compression from 'compression'

/** Private IPv4 addresses of this machine, Wi-Fi / Ethernet first, virtual adapters last. */
function lanAddresses(): string[] {
  const virtual = /vethernet|virtualbox|vmware|vbox|wsl|docker|loopback|bluetooth|hyper-v/i
  const out: { ip: string; rank: number }[] = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family !== 'IPv4' || i.internal || !/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(i.address)) continue
      out.push({ ip: i.address, rank: virtual.test(name) ? 2 : /wi-?fi|wlan|wireless/i.test(name) ? 0 : 1 })
    }
  }
  return out.sort((a, b) => a.rank - b.rank).map(x => x.ip)
}

/**
 * Local-only helpers (never part of the production build). Secrets are read from ../.env on the server side and are not
 * exposed to the browser bundle:  GET /local-api/nearby  (SerpAPI Google Maps)  and  POST /local-api/telegram  (bot message).
 */
function localApi(env: Record<string, string>, port: number): Plugin {
  const json = (res: any, status: number, body: unknown) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)) }
  const KINDS: Record<string, string> = { hospital: 'hospital', police: 'police station', school: 'school', fire: 'fire station', shelter: 'relief camp' }
  return {
    name: 'jalnetra-local-api',
    apply: 'serve',
    configureServer(server) {
      // gzip everything: the unbundled dev modules and the 2.5 MB data file are too slow to load over phone Wi-Fi otherwise
      server.middlewares.use(compression({ threshold: 1024 }) as any)
      // Short links: a route is stored under a short id, so the QR code and the Telegram message stay small.
      const routes = new Map<string, string>()
      const dirCache = new Map<string, unknown>()
      server.middlewares.use('/r', (req, res) => {
        const url = new URL(req.url ?? '/', 'http://x')
        const d = routes.get(url.pathname.replace(/^\/+/, ''))
        if (!d) { res.statusCode = 404; res.setHeader('content-type', 'text/plain; charset=utf-8'); return res.end('This route link has expired. Send it again from JalNetra.') }
        res.statusCode = 302; res.setHeader('location', `/route?d=${d}${url.searchParams.get('ar') ? '&ar=1' : ''}`); res.end()
      })
      server.middlewares.use('/local-api', async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', 'http://x')
          if (url.pathname === '/status') return json(res, 200, { base: (env.LAN_HOST || lanAddresses()[0]) ? `https://${env.LAN_HOST || lanAddresses()[0]}:${port}` : null, serpapi: !!env.SERPAPI_KEY, telegram: !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID), lan: lanAddresses() })
          if (url.pathname === '/directions' && req.method === 'GET') {
            // Google Maps walking distance, time and turns through SerpAPI (no geometry is returned). Cached per origin/destination.
            const f = (k: string) => Number(url.searchParams.get(k))
            const [a, b, c, d] = [f('flat'), f('flng'), f('tlat'), f('tlng')]
            if (!env.SERPAPI_KEY) return json(res, 503, { error: 'SERPAPI_KEY is not set in .env' })
            if (![a, b, c, d].every(Number.isFinite)) return json(res, 400, { error: 'flat, flng, tlat and tlng are required' })
            const mode = url.searchParams.get('mode') === 'driving' ? '0' : '2'   // SerpAPI travel_mode: 0 best (driving), 2 walking
            const key = mode + [a, b, c, d].map(n => n.toFixed(4)).join(',')
            const hit = dirCache.get(key)
            if (hit) return json(res, 200, hit)
            const q = new URLSearchParams({ engine: 'google_maps_directions', start_coords: `${a},${b}`, end_coords: `${c},${d}`, travel_mode: mode, api_key: env.SERPAPI_KEY })
            const r = await fetch(`https://serpapi.com/search.json?${q}`)
            const data: any = await r.json()
            const dir = data.directions?.[0]
            if (!r.ok || !dir) return json(res, 200, { directions: null })
            const out = { directions: { km: Number((dir.distance / 1000).toFixed(2)), minutes: Math.round(dir.duration / 60), steps: (dir.trips?.[0]?.details ?? []).map((s: any) => ({ meters: s.distance ?? 0, minutes: Math.max(1, Math.round((s.duration ?? 0) / 60)), direction: s.action ?? 'straight', text: String(s.title ?? 'Continue').replace(/\s+/g, ' ').trim() })) } }
            dirCache.set(key, out)
            return json(res, 200, out)
          }
          if (url.pathname === '/place' && req.method === 'GET') {
            // Exact location of a named safe place (Google Maps through SerpAPI): the result nearest the predicted point.
            const name = (url.searchParams.get('name') ?? '').slice(0, 120)
            const lat = Number(url.searchParams.get('lat')), lng = Number(url.searchParams.get('lng'))
            if (!env.SERPAPI_KEY) return json(res, 503, { error: 'SERPAPI_KEY is not set in .env' })
            if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return json(res, 400, { error: 'name, lat and lng are required' })
            const q = new URLSearchParams({ engine: 'google_maps', type: 'search', q: name, ll: `@${lat},${lng},15z`, api_key: env.SERPAPI_KEY })
            const r = await fetch(`https://serpapi.com/search.json?${q}`)
            const data: any = await r.json()
            const cands: any[] = [...(data.place_results ? [data.place_results] : []), ...(data.local_results ?? [])].filter(p => p.gps_coordinates)
            const km = (a: any) => Math.hypot((a.gps_coordinates.longitude - lng) * Math.cos(lat * Math.PI / 180), a.gps_coordinates.latitude - lat) * 111
            // a result whose title shares a word with the name may be up to 5 km away; otherwise only a very close one is trusted
            const words = name.toLowerCase().split(/[^a-z0-9ऀ-ॿ]+/).filter(w => w.length > 3 && !['government', 'primary', 'school', 'hospital', 'health', 'center', 'centre'].includes(w))
            const named = (p: any) => words.some(w => String(p.title ?? '').toLowerCase().includes(w))
            const best = cands.map(p => ({ p, d: km(p) })).filter(x => (named(x.p) ? x.d <= 5 : x.d <= 1.5)).sort((a, b) => a.d - b.d)[0]
            if (!r.ok || !best) return json(res, 200, { place: null })
            const p = best.p
            return json(res, 200, { place: { name: p.title, address: p.address, lat: p.gps_coordinates.latitude, lng: p.gps_coordinates.longitude, phone: p.phone } })
          }
          if (url.pathname === '/route' && req.method === 'POST') {
            let raw = ''
            for await (const c of req) { raw += c; if (raw.length > 60_000) return json(res, 413, { error: 'route too large' }) }
            const d = String(JSON.parse(raw || '{}').d ?? '')
            if (!/^[A-Za-z0-9_\-.~%]+$/.test(d)) return json(res, 400, { error: 'invalid route' })
            const id = randomBytes(5).toString('base64url')
            routes.set(id, d)
            if (routes.size > 500) routes.delete(routes.keys().next().value as string)
            return json(res, 200, { id })
          }
          if (url.pathname === '/nearby' && req.method === 'GET') {
            const lat = Number(url.searchParams.get('lat')), lng = Number(url.searchParams.get('lng'))
            const kind = KINDS[url.searchParams.get('type') ?? 'hospital']
            if (!env.SERPAPI_KEY) return json(res, 503, { error: 'SERPAPI_KEY is not set in .env' })
            if (!Number.isFinite(lat) || !Number.isFinite(lng) || !kind) return json(res, 400, { error: 'lat, lng and a known type are required' })
            const q = new URLSearchParams({ engine: 'google_maps', type: 'search', q: kind, ll: `@${lat},${lng},14z`, api_key: env.SERPAPI_KEY })
            const r = await fetch(`https://serpapi.com/search.json?${q}`)
            const data: any = await r.json()
            const places = (data.local_results ?? []).slice(0, 8).map((p: any) => ({ name: p.title, address: p.address, lat: p.gps_coordinates?.latitude, lng: p.gps_coordinates?.longitude, phone: p.phone, rating: p.rating }))
            return json(res, r.ok ? 200 : 502, r.ok ? { type: url.searchParams.get('type') ?? 'hospital', places } : { error: data.error ?? 'SerpAPI request failed' })
          }
          if (url.pathname === '/telegram' && req.method === 'POST') {
            if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return json(res, 503, { error: 'Telegram bot is not configured in .env' })
            let raw = ''
            for await (const c of req) { raw += c; if (raw.length > 4000) return json(res, 413, { error: 'message too long' }) }
            const text = String(JSON.parse(raw || '{}').text ?? '').slice(0, 3500)
            if (!text) return json(res, 400, { error: 'text is required' })
            const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }) })
            const data: any = await r.json()
            return json(res, r.ok ? 200 : 502, r.ok ? { ok: true } : { error: data.description ?? 'Telegram request failed' })
          }
          json(res, 404, { error: 'not found' })
        } catch (e) { json(res, 500, { error: (e as Error).message }) }
      })
    },
  }
}

export default defineConfig(({ command, mode }) => {
  const dev = command === 'serve'
  const env = { ...loadEnv(mode, '..', ''), ...loadEnv(mode, '.', '') }   // jalnetra/.env, or the one a level up (secrets stay server-side)
  const port = 5173
  // The API runs on this machine (local-backend/, same handler, .env credentials). Set USE_LOCAL_BACKEND=false to use the deployed API.
  const local = env.USE_LOCAL_BACKEND !== 'false'
  const host = env.LAN_HOST || lanAddresses()[0]
  // Phones only allow camera, GPS and compass on https, so the dev server is https and the AR QR code points at the LAN address.
  const lan = dev && host ? `https://${host}:${port}` : ''
  return {
    server: { host: true, port, strictPort: true, proxy: dev && local ? { '/india/snapshot.json': { target: 'http://127.0.0.1:8787', changeOrigin: true }, '/monitor': { target: 'http://127.0.0.1:8787', changeOrigin: true }, '/jn': { target: 'http://127.0.0.1:8787', changeOrigin: true, rewrite: (p: string) => p.replace(/^\/jn/, '') } } : undefined },
    define: {
      ...(lan && !process.env.VITE_PUBLIC_APP_URL ? { 'import.meta.env.VITE_PUBLIC_APP_URL': JSON.stringify(lan) } : {}),
      ...(dev && local ? { 'import.meta.env.VITE_JALNETRA_API': JSON.stringify('/jn') } : {}),
      // A Mapbox public (pk.) token is meant for browsers; restrict it by URL in your Mapbox account before sharing the site.
      ...(env.Mapbox_token || env.MAPBOX_TOKEN ? { 'import.meta.env.VITE_MAPBOX_TOKEN': JSON.stringify(env.Mapbox_token || env.MAPBOX_TOKEN) } : {}),
    },
    plugins: [react(), tailwindcss(), viteSingleFile(), ...(dev ? [basicSsl(), localApi(env, port)] : [])],
    build: { assetsInlineLimit: 100_000_000, chunkSizeWarningLimit: 10000 },
  }
})
