import { useEffect, useLayoutEffect, useState } from 'react'
import App from './App'
import Home from './live/Home'
import Live from './live/Live'
import Validate from './live/Validate'
import Story from './live/Story'
import PublicDemoFeed from './demo/PublicDemoFeed'
import RoutePage from './live/RoutePage'
import SimRoute from './live/SimRoute'
import AwsFlow from './live/AwsFlow'
import { WaterBackdrop } from './components/WaterBackdrop'

/**
 * The walkthrough is Home -> Glacier story -> Live. River Watch (all of India) and the Gandak live console are one screen, /live.
 * The old /river-watch, /gandak, /demo and #rivers / #demo links keep working and land on it.
 */
type Screen = { s: 'home' } | { s: 'aws' } | { s: 'route' } | { s: 'live'; mode: 'live' } | { s: 'public-demo'; sessionId: string } | { s: 'validate' } | { s: 'story' } | { s: 'history'; start: 'story' | 'explore' | 'ops'; incident?: string | null }
const LIVE: Screen = { s: 'live', mode: 'live' }
const parseHash = (h: string): Screen | null => {
  if (h === 'rivers' || h === 'live' || h === 'demo') return LIVE
  if (h === 'validate') return { s: 'validate' }
  if (h === 'story') return { s: 'story' }
  if (h === 'explore') return { s: 'history', start: 'explore' }
  if (h.startsWith('ops')) return { s: 'history', start: 'ops', incident: h.split('/')[1] ?? null }
  if (h === 'home') return { s: 'home' }
  return null
}

const parsePath = (pathname: string): Screen | null => {
  const path = pathname.replace(/\/$/, '').toLowerCase() || '/'
  if (path === '/home' || path === '/') return { s: 'home' }
  if (path === '/live' || path === '/gandak' || path === '/river-watch' || path === '/demo') return LIVE
  if (path.startsWith('/demo/feed/')) return { s: 'public-demo', sessionId: decodeURIComponent(path.slice('/demo/feed/'.length)) }
  if (path.startsWith('/demo/')) return LIVE
  if (path === '/route') return { s: 'route' }
  if (path === '/aws-flow' || path === '/aws' || path === '/how-aws-works') return { s: 'aws' }
  if (path === '/validation') return { s: 'validate' }
  if (path === '/glacier-story') return { s: 'story' }
  if (path === '/map') return { s: 'history', start: 'explore' }
  if (path === '/incidents' || path.startsWith('/incidents/')) {
    return { s: 'history', start: 'ops', incident: path.split('/')[2] ?? null }
  }
  return null
}

const parse = (): Screen => {
  // Hash routes take precedence when present so existing shared links such as /#ops/<incident> keep resolving.
  const hash = location.hash.replace(/^#/, '')
  if (hash) return parseHash(hash) ?? { s: 'story' }
  return parsePath(location.pathname) ?? { s: 'home' }
}
const pathOf = (x: Screen) => x.s === 'home' ? '/home' : x.s === 'aws' ? '/aws-flow' : x.s === 'live' ? '/live' : x.s === 'route' ? '/route' : x.s === 'public-demo' ? `/demo/feed/${encodeURIComponent(x.sessionId)}` : x.s === 'validate' ? '/validation' : x.s === 'story' ? '/glacier-story' : x.start === 'ops' ? `/incidents${x.incident ? '/' + encodeURIComponent(x.incident) : ''}` : '/map'

/** Screens: home, glacier story, the live map (India rivers + Gandak alerts), 2026 validation, historical map and operations. */
export default function Root() {
  return <><WaterBackdrop /><Screens /></>
}

function Screens() {
  const [scr, setScr] = useState<Screen>(parse)
  useEffect(() => {
    const f = () => setScr(parse())
    addEventListener('hashchange', f)
    addEventListener('popstate', f)
    return () => { removeEventListener('hashchange', f); removeEventListener('popstate', f) }
  }, [])
  // The glacier story keeps its original dark look; every other screen uses the light theme (see theme-light.css).
  useLayoutEffect(() => { document.documentElement.classList.toggle('theme-light', scr.s !== 'story') }, [scr.s])
  const go = (x: Screen) => { history.pushState({}, '', pathOf(x)); setScr(x) }
  const home = () => go({ s: 'home' }), live = () => go(LIVE), validate = () => go({ s: 'validate' })
  if (scr.s === 'route') return new URLSearchParams(location.search).has('sim') ? <SimRoute onHome={home} /> : <RoutePage onHome={home} />
  if (scr.s === 'aws') return <AwsFlow onHome={home} onLive={live} />
  if (scr.s === 'story') return <Story onHome={home} onRivers={live} onLive={live} />
  if (scr.s === 'home') return <Home onAws={() => go({ s: 'aws' })} onRivers={live} onLive={live} onDemo={live} onMap={() => go({ s: 'history', start: 'explore' })} onValidate={validate} onOps={() => go({ s: 'history', start: 'ops' })} onStory={() => go({ s: 'story' })} />
  if (scr.s === 'live') return <Live key="live" mode={scr.mode} onHome={home} onValidate={validate} onOpenIncident={id => go({ s: 'history', start: 'ops', incident: id })} />
  if (scr.s === 'public-demo') return <PublicDemoFeed sessionId={scr.sessionId} onHome={home} onDemo={live} />
  if (scr.s === 'validate') return <Validate onBack={home} onLive={live} onStory={() => go({ s: 'story' })} />
  return <App key={scr.start + (scr.incident ?? '')} start={scr.start} incidentId={scr.incident ?? null} onHome={home} onValidate={validate} onLive={live} onStory={() => go({ s: 'story' })} />
}
