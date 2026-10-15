import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import gsap from 'gsap'

// Pattern from React Bits' Magnet: the wrapped control is gently pulled toward the pointer.
export function Magnet({ children, strength = 0.25, className = '' }: { children: ReactNode; strength?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const media = gsap.matchMedia()
    media.add('(prefers-reduced-motion: no-preference) and (hover: hover)', () => {
      const xTo = gsap.quickTo(el, 'x', { duration: .5, ease: 'power3.out' })
      const yTo = gsap.quickTo(el, 'y', { duration: .5, ease: 'power3.out' })
      const move = (e: PointerEvent) => {
        const r = el.getBoundingClientRect()
        const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2)
        if (Math.abs(dx) < r.width && Math.abs(dy) < r.height * 1.6) { xTo(dx * strength); yTo(dy * strength) } else { xTo(0); yTo(0) }
      }
      const leave = () => { xTo(0); yTo(0) }
      window.addEventListener('pointermove', move)
      el.addEventListener('pointerleave', leave)
      return () => { window.removeEventListener('pointermove', move); el.removeEventListener('pointerleave', leave) }
    })
    return () => media.revert()
  }, [strength])
  return <span ref={ref} className={`magnet ${className}`}>{children}</span>
}
