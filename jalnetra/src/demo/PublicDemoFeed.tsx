import { useEffect, useRef, useState } from 'react'
import PredictionMap from './PredictionMap'
import { DemoApiError, getPublicFeed } from './api'
import type { PublicDemoFeed as Feed } from './types'
import { publicUrl } from './workflowState'
import { BackgroundBeams } from '../components/ui/background-beams'
import { CardSpotlight } from '../components/ui/card-spotlight'
import { useReveal } from '../components/ui/use-reveal'
import './demo.css'
import './demo-polish.css'

export default function PublicDemoFeed({ sessionId, onHome, onDemo }: { sessionId: string; onHome: () => void; onDemo: () => void }) {
  const [feed, setFeed] = useState<Feed | null>(null)
  const [error, setError] = useState('')
  const [missing, setMissing] = useState(false)
  const [copy, setCopy] = useState('')
  const shell = useRef<HTMLElement>(null)
  useReveal(shell, [feed?.items.length ?? -1, !!error])
  useEffect(() => {
    const controller = new AbortController()
    setFeed(null); setError(''); setMissing(false)
    getPublicFeed(sessionId, controller.signal).then(setFeed).catch(e => {
      if (controller.signal.aborted) return
      setMissing(e instanceof DemoApiError && (e.status === 404 || e.code === 'EMPTY_FEED'))
      setError(e instanceof DemoApiError && e.status === 404 ? 'This exercise feed does not exist or the public endpoint is not deployed.' : e instanceof DemoApiError && e.code === 'EMPTY_FEED' ? 'No approved exercise advisories have been published yet.' : e instanceof Error ? e.message : 'The public feed could not be loaded.')
    })
    return () => controller.abort()
  }, [sessionId])
  async function copyLink() {
    try { await navigator.clipboard.writeText(publicUrl(sessionId)); setCopy('Link copied') } catch { setCopy(publicUrl(sessionId)) }
  }
  return <main className="demo-shell demo-public" ref={shell}><BackgroundBeams className="demo-beams" /><header className="demo-header"><button className="demo-brand" onClick={onHome}><span className="demo-brand-icon">◈</span> जलनेत्र <span>JALNETRA</span></button><nav><button className="demo-button demo-quiet" onClick={onDemo}>Run the exercise ↗</button><span className="demo-tag">PUBLIC FEED</span></nav></header><div className="demo-banner"><strong>EXERCISE / अभ्यास</strong><span>Not a real flood warning. Approved synthetic advisories only.</span></div><div className="demo-content"><div className="demo-heading"><div><p className="demo-eyebrow">PUBLIC EXERCISE FEED</p><h1>What the operator approved.</h1><p>Read-only advisories from the Gandak replay. No phone numbers or owner details are shown here.</p></div><span className="demo-clock">SESSION<strong>{sessionId}</strong></span></div>{error && <section className={`demo-empty ${missing ? 'demo-empty-muted' : 'demo-error'}`}><h2>{missing ? 'Nothing approved yet' : 'Feed unavailable'}</h2><p>{error}</p><div><button className="demo-button" onClick={onHome}>Back home</button><button className="demo-button demo-primary" onClick={onDemo}>Open operator workflow</button></div></section>}{feed && <><div className="demo-public-tools"><span><strong>{feed.items.length}</strong> approved advisory{feed.items.length === 1 ? '' : 'ies'} · generated {new Date(feed.generatedAt).toLocaleString()}</span><button className="demo-button" onClick={() => void copyLink()}>Share / copy link</button><small>{copy}</small></div>{feed.items.length === 0 ? <section className="demo-empty demo-empty-muted"><h2>No approved advisories yet</h2><p>An operator must approve an alert before it appears in this anonymous feed.</p></section> : <div className="demo-feed-list">{feed.items.sort((a, b) => a.order - b.order).map(item => <CardSpotlight className="demo-feed-card" key={item.id} data-reveal><div className="demo-feed-card-top"><span className="demo-alert-number">0{item.order}</span><div><p className="demo-eyebrow">APPROVED ADVISORY · {item.prediction.district}</p><h2>{item.prediction.villageName}</h2><span className="demo-status demo-status-dispatched">{item.demoCall === 'dispatched' ? 'Demo call dispatched' : 'Call not confirmed'}</span></div><time>{new Date(item.approvedAt).toLocaleString()}</time></div><PredictionMap prediction={item.prediction} horizon={item.prediction.horizonHours!} readOnly /><div className="demo-public-message"><p lang="hi">{item.messageHi}</p><p lang="en">{item.messageEn}</p></div></CardSpotlight>)}</div>}</>}
      <footer className="demo-footer"><span>Anonymous public view · {sessionId}</span><span>Not an evacuation instruction. Follow local authority guidance.</span></footer></div></main>
}
