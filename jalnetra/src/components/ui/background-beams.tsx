import { useEffect, useRef } from 'react'
import gsap from 'gsap'

// Adapted from Aceternity UI's Background Beams (Manu Arora): SVG paths with travelling gradients.
// Animation is driven by GSAP instead of framer-motion and is disabled for reduced-motion users.
const PATHS = Array.from({ length: 18 }, (_, i) => {
  const o = i * 18
  return `M-${380 - o} -${189 + i * 6}C-${380 - o} -${189 + i * 6} -${312 - o} ${216 - i * 6} ${152 - o} ${343 - i * 6}C${616 - o} ${470 - i * 6} ${684 - o} ${875 - i * 6} ${684 - o} ${875 - i * 6}`
})

export function BackgroundBeams({ className = '' }: { className?: string }) {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const media = gsap.matchMedia()
    media.add('(prefers-reduced-motion: no-preference)', () => {
      ref.current!.querySelectorAll('linearGradient').forEach((g, i) => {
        gsap.fromTo(g, { attr: { x1: '0%', x2: '0%', y1: '0%', y2: '0%' } }, { attr: { x1: '100%', x2: '120%', y1: '100%', y2: '120%' }, duration: 9 + (i % 7) * 1.7, delay: (i % 5) * 0.8, repeat: -1, ease: 'none' })
      })
    })
    return () => media.revert()
  }, [])
  return (
    <div className={`bg-beams ${className}`} aria-hidden="true">
      <svg ref={ref} viewBox="0 0 696 316" fill="none" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">
        {PATHS.map((d, i) => <path key={i} d={d} stroke="rgba(94,234,212,.09)" strokeWidth=".5" />)}
        {PATHS.map((d, i) => <path key={`b${i}`} d={d} stroke={`url(#beam-${i})`} strokeWidth=".6" />)}
        <defs>
          {PATHS.map((_, i) => (
            <linearGradient id={`beam-${i}`} key={i} gradientUnits="userSpaceOnUse" x1="0%" x2="0%" y1="0%" y2="0%">
              <stop stopColor="#18CCFC" stopOpacity="0" />
              <stop stopColor="#18CCFC" />
              <stop offset="32.5%" stopColor="#6344F5" />
              <stop offset="100%" stopColor="#AE48FF" stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
      </svg>
    </div>
  )
}
