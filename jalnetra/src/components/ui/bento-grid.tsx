import type { ReactNode } from 'react'

// Adapted from Aceternity UI's Bento Grid registry source:
// https://ui.aceternity.com/registry/bento-grid.json
// Original author: Manu Arora <hi@manuarora.in>
export function BentoGrid({ className = '', children }: { className?: string; children?: ReactNode }) {
  return <div className={`aceternity-bento-grid ${className}`}>{children}</div>
}

export function BentoGridItem({ className = '', title, description, header, icon }: { className?: string; title?: ReactNode; description?: ReactNode; header?: ReactNode; icon?: ReactNode }) {
  return (
    <div className={`aceternity-bento-item ${className}`}>
      {header}
      <div className="aceternity-bento-copy">
        {icon}
        <div className="aceternity-bento-title">{title}</div>
        <div className="aceternity-bento-description">{description}</div>
      </div>
    </div>
  )
}
