import { useEffect, useRef } from 'react'
import gsap from 'gsap'

// Adapted from Aceternity UI's Text Generate Effect (Manu Arora): words fade and un-blur in sequence.
export type GenLine = { text: string; accent?: boolean }
export function TextGenerateEffect({ lines, className = '' }: { lines: GenLine[]; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const media = gsap.matchMedia()
    media.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.fromTo(ref.current!.querySelectorAll('.tge-word'), { opacity: 0, y: 10, filter: 'blur(10px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: .7, ease: 'power3.out', stagger: .09, clearProps: 'filter,transform' })
    })
    return () => media.revert()
  }, [])
  return (
    <div className={`tge ${className}`} ref={ref}>
      {lines.map((l, i) => (
        <span key={i} className={`tge-line${l.accent ? ' tge-accent' : ''}`}>
          {l.text.split(' ').map((w, j) => <span key={j} className="tge-word">{w}&nbsp;</span>)}
        </span>
      ))}
    </div>
  )
}
