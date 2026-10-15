import { useEffect, useMemo, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { FiCamera, FiX } from 'react-icons/fi'
import { bearing, metres, shortRouteLink, type SharedRoute } from './routeShare'
import { distanceToRiver, floodRing, fmtHours, hoursUntil, toXY, type LL } from './sim'

export type Flood = { river: LL[]; hours: number; halfWidth: (h: number) => number }
type Fix = { lat: number; lng: number; acc: number | null }

const CAM_H = 1.5            // metres: phone held at chest height
const V_FOV = 63, MAX_ANGLE = 75
const rad = (d: number) => (d * Math.PI) / 180
const wrap = (d: number) => ((d + 540) % 360) - 180   // -180..180
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

/** Camera heading (where the back of the phone points, 0 = north) and elevation from the W3C Euler angles. */
function cameraPose(alpha: number, beta: number, gamma: number): { heading: number; pitch: number } {
  const a = rad(alpha), b = rad(beta), g = rad(gamma)
  const cA = Math.cos(a), sA = Math.sin(a), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g)
  const rA = -cA * sG - sA * sB * cG, rB = -sA * sG + cA * sB * cG
  let h = Math.atan(rA / rB)
  if (rB < 0) h += Math.PI; else if (rA < 0) h += 2 * Math.PI
  // elevation of the camera axis: upright phone (beta 90) looks at the horizon
  const pitch = clamp(beta - 90, -85, 85)
  return { heading: (h * 180) / Math.PI, pitch }
}

/** Top-down radar in the corner: you at the centre, facing up, with the flood and the route around you. */
function MiniMap({ fix, heading, route, flood }: { fix: Fix; heading: number; route: SharedRoute; flood: Flood }) {
  const S = 132, mPerPx = 7, th = rad(heading)
  const at = (lat: number, lng: number): [number, number] => {
    const [dx, dy] = toXY([fix.lat, fix.lng], [lat, lng])
    return [S / 2 + (dx * Math.cos(th) - dy * Math.sin(th)) / mPerPx, S / 2 - (dx * Math.sin(th) + dy * Math.cos(th)) / mPerPx]
  }
  const ring = floodRing(flood.river, fix.lat, flood.halfWidth(flood.hours)).map(([lng, lat]) => at(lat, lng).join(',')).join(' ')
  const path = route.path.map(([lng, lat]) => at(lat, lng).join(',')).join(' ')
  return (
    <svg className="ar-mini" viewBox={`0 0 ${S} ${S}`} aria-label="Top-down view of the flood and route">
      <defs><clipPath id="mm"><circle cx={S / 2} cy={S / 2} r={S / 2 - 2} /></clipPath></defs>
      <circle cx={S / 2} cy={S / 2} r={S / 2 - 1} fill="rgba(8,20,16,.62)" />
      <g clipPath="url(#mm)">
        <polygon points={ring} fill="rgba(56,140,240,.65)" stroke="#bfe0ff" strokeWidth="1" />
        <polyline points={path} fill="none" stroke="#34d399" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <path d={`M${S / 2},${S / 2 - 8} L${S / 2 + 6},${S / 2 + 6} L${S / 2},${S / 2 + 2} L${S / 2 - 6},${S / 2 + 6} Z`} fill="#f5b74a" stroke="#fff" strokeWidth="1.2" />
      <text x={S / 2} y="13" fontSize="10" fontWeight="700" fill="#fff" textAnchor="middle">AHEAD</text>
    </svg>
  )
}

/**
 * Augmented-reality route: things are anchored to the world, not to the screen. The route is drawn as chevrons on the ground,
 * the safe place is a pin at its real bearing, and (in the simulation) flood water covers the ground where it is predicted.
 * Positions come from GPS and compass, so accuracy is a few metres at best.
 */
export function ArView({ route, onClose, flood }: { route: SharedRoute; onClose: () => void; flood?: Flood }) {
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const [fix, setFix] = useState<Fix | null>(null)
  const [pose, setPose] = useState<{ heading: number; pitch: number } | null>(null)
  const [camOk, setCamOk] = useState(false)
  const [camErr, setCamErr] = useState('')
  const [geoErr, setGeoErr] = useState('')
  const [started, setStarted] = useState(false)
  const [qr, setQr] = useState<string | null>(null)
  const [qrBusy, setQrBusy] = useState(false)
  const [qrErr, setQrErr] = useState('')
  const [qrUrl, setQrUrl] = useState('')
  const [preview, setPreview] = useState(false)
  const [testRoute, setTestRoute] = useState<SharedRoute | null>(null)
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight })
  const eff = testRoute ?? route
  const smooth = useRef<number | null>(null)

  useEffect(() => { const f = () => setSize({ w: window.innerWidth, h: window.innerHeight }); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f) }, [])

  const start = async () => {
    setStarted(true)
    try {
      const DOE = (window as any).DeviceOrientationEvent
      if (DOE && typeof DOE.requestPermission === 'function') await DOE.requestPermission()   // iOS: must come from a tap
    } catch { /* continue without the compass */ }
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      if (video.current) { video.current.srcObject = stream.current; await video.current.play().catch(() => {}); setCamOk(true) }
    } catch (e) { setCamErr((e as Error).message || 'Camera unavailable') }
    if (!navigator.geolocation) setGeoErr('Location is not available on this device.')
  }
  const startFromDesktop = async () => {
    const phone = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
    if (phone) { await start(); return }
    setQrBusy(true); setQrErr(''); setQr(null)
    try {
      const link = await shortRouteLink(route, true)
      setQrUrl(link)
      setQr(await QRCode.toDataURL(link, { errorCorrectionLevel: 'M', margin: 2, width: 280 }))
    } catch (e) { setQrErr((e as Error).message || 'Could not create the QR code') }
    finally { setQrBusy(false) }
  }
  useEffect(() => () => { stream.current?.getTracks().forEach(t => t.stop()) }, [])

  useEffect(() => {
    if (!started || preview || !navigator.geolocation) return
    const id = navigator.geolocation.watchPosition(
      p => { setFix({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }); setGeoErr('') },
      e => setGeoErr(e.message || 'Location unavailable'), { enableHighAccuracy: true, maximumAge: 1500, timeout: 20000 })
    return () => navigator.geolocation.clearWatch(id)
  }, [started, preview])

  useEffect(() => {
    if (!started || preview) return
    const on = (e: any) => {
      if (typeof e.beta !== 'number' || typeof e.gamma !== 'number') return
      let alpha: number | null = null
      if (typeof e.webkitCompassHeading === 'number') alpha = (360 - e.webkitCompassHeading) % 360          // iOS: true compass
      else if ((e.absolute || e.type === 'deviceorientationabsolute') && typeof e.alpha === 'number') alpha = e.alpha  // Android
      if (alpha === null) return
      const p = cameraPose(alpha, e.beta, e.gamma)
      // low-pass the heading on the circle so the overlay does not shake
      const prev = smooth.current
      const h = prev === null ? p.heading : (prev + wrap(p.heading - prev) * 0.25 + 360) % 360
      smooth.current = h
      setPose({ heading: h, pitch: p.pitch })
    }
    window.addEventListener('deviceorientationabsolute', on, true)
    window.addEventListener('deviceorientation', on, true)
    return () => { window.removeEventListener('deviceorientationabsolute', on, true); window.removeEventListener('deviceorientation', on, true) }
  }, [started, preview])

  const startPreview = (heading = 0) => { setPreview(true); setFix({ lat: eff.from[0], lng: eff.from[1], acc: null }); setPose({ heading, pitch: 0 }); setStarted(true) }

  const here: LL | null = fix ? [fix.lat, fix.lng] : null
  const nav = useMemo(() => {
    if (!here) return null
    const pts = eff.path.map(([lng, lat]) => [lat, lng] as LL)
    let near = 0, nd = Infinity
    pts.forEach((p, i) => { const d = metres(here, p); if (d < nd) { nd = d; near = i } })
    let left = nd
    for (let i = near; i < pts.length - 1; i++) left += metres(pts[i], pts[i + 1])
    // points along the route ahead of you, every 6 m, up to 220 m
    const ahead: { lat: number; lng: number; along: number }[] = []
    let along = 0, next = 6
    for (let i = near; i < pts.length - 1 && along < 220; i++) {
      const seg = metres(pts[i], pts[i + 1])
      while (next <= along + seg && next < 220) {
        const t = (next - along) / Math.max(seg, 1e-6)
        ahead.push({ lat: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, lng: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t, along: next })
        next += 6
      }
      along += seg
    }
    return { toRoute: nd, left, ahead, arrived: metres(here, eff.to) < 25, next: bearing(here, ahead[1] ? [ahead[1].lat, ahead[1].lng] : eff.to) }
  }, [fix, eff]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- projection of world points into the camera view ----
  const proj = (target: LL, groundY = true, heightM = 0): { x: number; y: number; d: number; off: number } | null => {
    if (!here || !pose) return null
    const d = Math.max(metres(here, target), 0.5)
    const off = wrap(bearing(here, target) - pose.heading)
    if (Math.abs(off) > MAX_ANGLE) return null
    const f = (size.h / 2) / Math.tan(rad(V_FOV / 2))
    const elev = groundY ? -Math.atan((CAM_H - heightM) / d) * 180 / Math.PI : 0
    const x = size.w / 2 + f * Math.tan(rad(off))
    const y = size.h / 2 - f * Math.tan(rad(elev - pose.pitch))
    return { x, y, d, off }
  }
  const dest = proj(eff.to, true, -8)    // pin floats ~8 m above ground so it is visible from far away
  const destOff = here && pose ? wrap(bearing(here, eff.to) - pose.heading) : null

  // flood water: a polygon on the ground from the water's edge out to the horizon, in the direction of the river
  const water = useMemo(() => {
    if (!flood || !here || !pose) return null
    const dRiver = distanceToRiver(here, flood.river)
    const edge = Math.max(dRiver - flood.halfWidth(flood.hours), 0)
    let nearest = flood.river[0], nd = Infinity
    flood.river.forEach(p => { const d = metres(here, p); if (d < nd) { nd = d; nearest = p } })
    const bRiver = bearing(here, nearest)
    const pts: string[] = []
    const f = (size.h / 2) / Math.tan(rad(V_FOV / 2))
    const sx = (offDeg: number) => size.w / 2 + f * Math.tan(rad(clamp(offDeg, -85, 85)))
    const horizonY = size.h / 2 - f * Math.tan(rad(0 - pose.pitch))
    const bottom: [number, number][] = []
    for (let t = -70; t <= 70; t += 10) {
      const dist = Math.max(edge, 0.8) / Math.cos(rad(t))
      const off = wrap(bRiver + t - pose.heading)
      const elev = -Math.atan(CAM_H / dist) * 180 / Math.PI
      bottom.push([sx(off), size.h / 2 - f * Math.tan(rad(elev - pose.pitch))])
    }
    const first = bottom[0], last = bottom[bottom.length - 1]
    pts.push(`${first[0]},${horizonY}`, ...bottom.map(([x, y]) => `${x},${y}`), `${last[0]},${horizonY}`)
    return { points: pts.join(' '), edge, dRiver, minY: Math.min(...bottom.map(b => b[1])), horizonY }
  }, [flood, here, pose, size]) // eslint-disable-line react-hooks/exhaustive-deps

  const metresText = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`)
  const turnHint = destOff === null ? null : Math.abs(destOff) > 28 ? (destOff > 0 ? `Turn right ${Math.round(destOff)}°` : `Turn left ${Math.round(-destOff)}°`) : null

  return (
    <div className="ar" role="dialog" aria-label="AR route">
      <video ref={video} className="ar-video" playsInline muted style={{ display: camOk ? 'block' : 'none' }} />
      {!camOk && <div className="ar-sky" aria-hidden="true" />}
      <button className="ar-close" onClick={onClose} aria-label="Close AR view"><FiX /></button>

      {!started ? (
        <div className="ar-start">
          <h2>AR route to {route.shelter}</h2>
          {!qr ? <>
            <p>On a laptop? Start here to show a QR code. Scan it with your phone, then allow camera, location and compass access there.</p>
            <button className="route-btn primary" onClick={() => void startFromDesktop()} disabled={qrBusy}><FiCamera /> {qrBusy ? 'Creating QR code…' : 'Start AR'}</button>
          </> : <>
            <img className="ar-qr" src={qr} alt="QR code to open this AR route on a phone" />
            <p>Scan this code with your phone to open the route there. Keep both devices on the same network when running locally.</p>
            <small className="ar-qr-url">{qrUrl}</small>
            <button className="ar-link" onClick={() => setQr(null)}>Back</button>
          </>}
          {qrErr && <p className="err">{qrErr}</p>}
          <button className="ar-link" onClick={() => startPreview(0)}>No phone? Preview on this screen</button>
        </div>
      ) : (
        <>
          <div className="ar-layer" aria-hidden="true">
            {water && <svg className="ar-water" width={size.w} height={size.h}>
              <defs><linearGradient id="wg" gradientUnits="userSpaceOnUse" x1="0" x2="0" y1={water.horizonY} y2={size.h}><stop offset="0" stopColor="#9fd2ff" stopOpacity=".5" /><stop offset="1" stopColor="#1760c8" stopOpacity=".82" /></linearGradient></defs>
              <polygon points={water.points} fill="url(#wg)" />
            </svg>}
            {nav?.ahead.map((p, i) => {
              const s = proj([p.lat, p.lng], true, 0)
              if (!s || s.d < 3) return null
              const scale = clamp(1.5 - s.d / 90, 0.3, 1.15)
              return <span key={i} className="ar-chev" style={{ left: s.x, top: s.y, transform: `translate(-50%,-50%) scale(${scale})`, opacity: clamp(1.05 - s.d / 260, 0.25, 1) }} />
            })}
            {dest && <div className="ar-pin" style={{ left: dest.x, top: clamp(dest.y, 90, size.h - 150) }}><b>{eff.shelter}</b><span>{metresText(dest.d)}</span><i /></div>}
            {water && water.dRiver < 900 && pose && here && (() => {
              const nearest = flood!.river.reduce((a, p) => (metres(here, p) < metres(here, a) ? p : a), flood!.river[0])
              const s = proj(nearest, true, 0)
              return s ? <div className="ar-waterlabel" style={{ left: s.x, top: clamp(s.y - 30, 90, size.h - 160) }}>Flood water · {metresText(water.edge)} away</div> : null
            })()}
          </div>

          {turnHint && !nav?.arrived && <div className={`ar-edge ${destOff! > 0 ? 'right' : 'left'}`}>{destOff! > 0 ? `${turnHint} ›` : `‹ ${turnHint}`}</div>}
          {nav?.arrived && <div className="ar-arrived">You have reached {eff.shelter}</div>}
          {flood && fix && pose && <MiniMap fix={fix} heading={pose.heading} route={eff} flood={flood} />}
          {flood && fix && <div className="ar-eta">Water reaches you in {fmtHours(hoursUntil(distanceToRiver([fix.lat, fix.lng], flood.river)))}<small>at the simulated spread</small></div>}

          <div className="ar-bottom">
            <div className="ar-dist">{nav ? `${metresText(nav.left)} to go` : 'Finding your position…'}</div>
            <div className="ar-to">to {eff.shelter}</div>
            <div className="ar-meta">
              {preview && <span>Preview: standing at {route.v}. Drag the sliders to look around.</span>}
              {!preview && fix?.acc != null && <span>GPS ±{Math.round(fix.acc)} m{fix.acc > 25 ? ' (low accuracy: step outside)' : ''}</span>}
              {!preview && !pose && <span>Waiting for the compass. Hold the phone upright; wave it in a figure-8 if needed.</span>}
              {nav && nav.toRoute > 200 && !preview && <span>You are {Math.round(nav.toRoute)} m from the route.</span>}
              {geoErr && <span>{geoErr}</span>}
              {camErr && <span>Camera: {camErr}</span>}
            </div>
            {preview && pose && <div className="ar-sliders">
              <label>Look direction <input type="range" min={0} max={359} value={Math.round(pose.heading)} onChange={e => setPose(p => ({ heading: Number(e.target.value), pitch: p?.pitch ?? 0 }))} /></label>
              <label>Tilt <input type="range" min={-30} max={30} value={Math.round(pose.pitch)} onChange={e => setPose(p => ({ heading: p?.heading ?? 0, pitch: Number(e.target.value) }))} /></label>
            </div>}
            <div className="ar-actions">
              {fix && !testRoute && !preview && <button className="ar-link" onClick={() => {
                const to: [number, number] = [fix.lat + 0.0036, fix.lng]
                setTestRoute({ ...route, from: [fix.lat, fix.lng], to, shelter: 'Test spot, 400 m north', km: 0.4, path: [[fix.lng, fix.lat], [to[1], to[0]]] })
              }}>Test here: route 400 m north of you</button>}
              {testRoute && <button className="ar-link" onClick={() => setTestRoute(null)}>Back to the real route</button>}
              {!preview && <button className="ar-link" onClick={() => startPreview(0)}>No GPS? Preview at {route.v}</button>}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
