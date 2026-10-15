import { useEffect } from 'react'
import type { RefObject } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'

gsap.registerPlugin(ScrollTrigger)

// Nearest ancestor (or the element itself) that scrolls; the window otherwise.
function scrollerOf(el: HTMLElement): HTMLElement | undefined {
  for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY
    if (o === 'auto' || o === 'scroll') return n
  }
  return undefined
}

// Animates every [data-reveal] descendant into view (staggered, scroll-triggered), once.
// Motion is skipped for prefers-reduced-motion and cleaned up on dependency change/unmount.
export function useReveal(root: RefObject<HTMLElement | null>, deps: unknown[]) {
  useEffect(() => {
    if (!root.current) return
    const media = gsap.matchMedia()
    const ctx = gsap.context(() => {
      media.add('(prefers-reduced-motion: no-preference)', () => {
        const items = gsap.utils.toArray<HTMLElement>('[data-reveal]', root.current!)
        if (!items.length) return
        gsap.set(items, { opacity: 0, y: 18 })
        ScrollTrigger.batch(items, {
          start: 'top 94%', once: true, scroller: scrollerOf(root.current!),
          onEnter: batch => gsap.to(batch, { opacity: 1, y: 0, duration: .6, ease: 'power3.out', stagger: .07, overwrite: true, clearProps: 'transform' }),
        })
        ScrollTrigger.refresh()
        // Safety net: never leave content hidden if a trigger does not fire.
        gsap.delayedCall(3, () => gsap.to(items, { opacity: 1, y: 0, duration: .3, overwrite: 'auto', clearProps: 'transform' }))
      })
    }, root)
    return () => { media.revert(); ctx.revert() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
