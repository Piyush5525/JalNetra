import type { HTMLAttributes, MouseEvent, ReactNode } from 'react'

// Adapted from Aceternity UI's Card Spotlight / Hover Border Gradient: a radial highlight follows the pointer.
type Props = HTMLAttributes<HTMLDivElement> & { children?: ReactNode }
export function CardSpotlight({ className = '', children, onMouseMove, ...rest }: Props) {
  const move = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`)
    e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`)
    onMouseMove?.(e)
  }
  return <div {...rest} className={`card-spotlight ${className}`} onMouseMove={move}>{children}</div>
}
