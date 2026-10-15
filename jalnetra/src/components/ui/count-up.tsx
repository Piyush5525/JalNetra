import { useEffect, useRef } from 'react'
import gsap from 'gsap'

// Pattern from React Bits' Count Up, driven by GSAP. Renders the final value when motion is reduced.
export function CountUp({ to, duration = 1.4, className = '', pad = 0 }: { to: number; duration?: number; className?: string; pad?: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const fmt = (n: number) => String(Math.round(n)).padStart(pad, '0')
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const media = gsap.matchMedia()
    media.add('(prefers-reduced-motion: no-preference)', () => {
      const state = { v: 0 }
      gsap.to(state, { v: to, duration, ease: 'power2.out', onUpdate: () => { el.textContent = fmt(state.v) } })
    })
    return () => media.revert()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, duration, pad])
  return <span ref={ref} className={className}>{fmt(to)}</span>
}
