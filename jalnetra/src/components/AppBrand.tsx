/** The JalNetra logo, shown top-left on every screen. Clicking it always returns to the home page. */
export function AppBrand({ onClick, className = '' }: { onClick: () => void; className?: string }) {
  return <button className={`app-brand ${className}`} onClick={onClick} aria-label="JalNetra, go to home"><img src="/brand/jalnetra-logo.png" alt="JalNetra" height={32} /></button>
}
