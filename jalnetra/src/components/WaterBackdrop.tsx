import { useLayoutEffect, useRef } from 'react'
import gsap from 'gsap'

/** Slow layered waves along the bottom of every light-theme screen. Pure decoration: pointer-events none, paused for reduced motion. */
const P = 1440
function wavePath(amp: number, cycles: number, phase: number, base: number) {
  const pts: string[] = []
  for (let x = 0; x <= P * 2; x += 24) {
    const y = base + amp * Math.sin((x / P) * Math.PI * 2 * cycles + phase) + amp * 0.35 * Math.sin((x / P) * Math.PI * 2 * cycles * 2 + phase * 1.7)
    pts.push(`${x},${y.toFixed(1)}`)
  }
  return `M0,200 L${pts.join(' L')} L${P * 2},200 Z`
}
const LAYERS = [
  { amp: 7, cycles: 2, phase: 0.4, base: 70, fill: 'rgba(43,108,176,.06)', dur: 46, dir: -1 },
  { amp: 9, cycles: 3, phase: 2.1, base: 92, fill: 'rgba(27,122,90,.07)', dur: 34, dir: 1 },
  { amp: 6, cycles: 4, phase: 4.0, base: 114, fill: 'rgba(43,108,176,.09)', dur: 26, dir: -1 },
  { amp: 5, cycles: 5, phase: 5.3, base: 136, fill: 'rgba(15,74,56,.08)', dur: 20, dir: 1 },
]

export function WaterBackdrop() {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const ctx = gsap.context(() => {
      gsap.utils.toArray<SVGPathElement>('.wb-layer').forEach((el, i) => {
        const L = LAYERS[i]
        gsap.fromTo(el, { x: L.dir < 0 ? 0 : -P }, { x: L.dir < 0 ? -P : 0, duration: L.dur, ease: 'none', repeat: -1 })
        gsap.to(el, { y: i % 2 ? 5 : -5, duration: 3.2 + i * 0.7, ease: 'sine.inOut', yoyo: true, repeat: -1 })
      })
      gsap.fromTo('.wb-drop', { attr: { r: 2 }, opacity: 0.5 }, { attr: { r: 26 }, opacity: 0, duration: 4, ease: 'sine.out', repeat: -1, stagger: 1.3 })
    }, root)
    return () => ctx.revert()
  }, [])
  return (
    <div ref={root} className="water-bd" aria-hidden="true">
      <svg viewBox={`0 0 ${P} 200`} preserveAspectRatio="none">
        {LAYERS.map((L, i) => <path key={i} className="wb-layer" d={wavePath(L.amp, L.cycles, L.phase, L.base)} fill={L.fill} />)}
        <g fill="none" stroke="rgba(43,108,176,.35)" strokeWidth="1.2">
          {[[300, 150], [820, 162], [1180, 146]].map(([x, y], i) => <circle key={i} className="wb-drop" cx={x} cy={y} r="2" />)}
        </g>
      </svg>
    </div>
  )
}
