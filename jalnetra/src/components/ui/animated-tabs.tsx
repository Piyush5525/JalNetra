import { useEffect, useLayoutEffect, useRef } from 'react'
import gsap from 'gsap'

// Pattern from Aceternity UI's Tabs: a highlight pill slides to the active tab. Driven by GSAP; instant for reduced motion.
export type TabItem<T extends string> = { id: T; label: string }
export function AnimatedTabs<T extends string>({ tabs, value, onChange, className = '' }: { tabs: TabItem<T>[]; value: T; onChange: (id: T) => void; className?: string }) {
  const root = useRef<HTMLDivElement>(null)
  const pill = useRef<HTMLSpanElement>(null)
  const first = useRef(true)
  const place = () => {
    const el = root.current?.querySelector<HTMLElement>(`[data-tab="${value}"]`)
    if (!el || !pill.current) return
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const vars = { x: el.offsetLeft, width: el.offsetWidth }
    if (first.current || reduce) { gsap.set(pill.current, vars); first.current = false } else gsap.to(pill.current, { ...vars, duration: .35, ease: 'power3.out' })
  }
  useLayoutEffect(place, [value, tabs.length]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const f = () => place(); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f) }, [value]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className={`atabs ${className}`} ref={root} role="tablist">
      <span className="atabs-pill" ref={pill} aria-hidden="true" />
      {tabs.map(t => <button key={t.id} data-tab={t.id} role="tab" aria-selected={t.id === value} className={t.id === value ? 'on' : ''} onClick={() => onChange(t.id)}>{t.label}</button>)}
    </div>
  )
}
