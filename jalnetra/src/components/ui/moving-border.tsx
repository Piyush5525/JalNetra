import type { ButtonHTMLAttributes, ReactNode } from 'react'

// Adapted from Aceternity UI's Moving Border button: a light travels around the button edge.
type Props = ButtonHTMLAttributes<HTMLButtonElement> & { children?: ReactNode }
export function MovingBorderButton({ className = '', children, ...rest }: Props) {
  return <button {...rest} className={`moving-border ${className}`}><span className="moving-border-inner">{children}</span></button>
}
