import { useEffect, useRef, useState } from 'react'
import gsap from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { FiArrowRight, FiArrowUpRight, FiBarChart2, FiFileText, FiRefreshCw, FiShield, FiUser, FiChevronDown } from 'react-icons/fi'
import { MdWaves } from 'react-icons/md'
import { fmtIST } from './shared'
import { TextGenerateEffect } from '../components/ui/text-generate-effect'
import { CardSpotlight } from '../components/ui/card-spotlight'
import { MovingBorderButton } from '../components/ui/moving-border'
import { CountUp } from '../components/ui/count-up'
import { Magnet } from '../components/ui/magnet'
import { useReveal } from '../components/ui/use-reveal'
import './home.css'

type Pub = { river: { created_at: string; points: number; normal: number; rising: number; warning: number; danger: number; headline: string; flagged: { river: string; near: string; status: string; trend?: string }[] } | null; gandak: { created_at: string; river: string; at_risk: number; overall: string } | null }
type Props = { onAws?: () => void; onRivers: () => void; onLive: () => void; onDemo: () => void; onMap: () => void; onValidate: () => void; onOps: () => void; onStory: () => void }

const FLOW = [
  { n: '01', t: 'Signals', d: 'River forecasts from monitored points across the network.' },
  { n: '02', t: 'Terrain', d: 'Elevation and village exposure place the water on the ground.' },
  { n: '03', t: 'Prediction', d: 'Inundation and a suggested route at now, +3, +6, +12 and +24 hours.' },
  { n: '04', t: 'Approval', d: 'An operator reviews the map and advisory. Nothing sends itself.' },
  { n: '05', t: 'Call', d: 'One call to the server-configured number, never to village contacts.' },
]
const SAFETY = [
  ['No automatic calls', 'Opening, loading or selecting an alert never places a call. Only an explicit approval does.'],
  ['One destination', 'A call can reach only the server-configured demo number. Village contacts are never dialled.'],
  ['One attempt, no retries', 'Each alert gets a single attempt, with a cooldown and a three-call allowance per session.'],
  ['Honest outcomes', '"Dispatched" is never shown as "answered". Failed and unknown outcomes stay locked.'],
  ['Exercise is labelled', 'Synthetic replay data is kept apart from real incidents and marked EXERCISE throughout.'],
]
const DATA = ['Sentinel-1 and Sentinel-2 (Planetary Computer)', 'GloFAS discharge and rain (Open-Meteo)', 'Copernicus DEM GLO-30', 'OpenStreetMap', 'GeoNames']

export default function Home({ onAws, onRivers, onLive, onMap, onStory }: Props) {
  const [pub, setPub] = useState<Pub | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const art = useRef<SVGSVGElement>(null)
  const peak = useRef<SVGSVGElement>(null)
  const line = useRef<HTMLDivElement>(null)
  useEffect(() => { fetch('/india/snapshot.json').then(r => (r.ok ? r.json() : Promise.reject(new Error('no own snapshot')))).catch(() => fetch('https://oceaylrebzflgyxfjqfb.supabase.co/functions/v1/jalnetra-public').then(r => r.json())).then(setPub).catch(e => setErr(String(e.message ?? e))) }, [])
  useReveal(root, [])

  useEffect(() => {
    const media = gsap.matchMedia()
    media.add('(prefers-reduced-motion: no-preference)', () => {
      const draw = (svg: SVGSVGElement | null, sel: string, stagger: number, dur: number) => {
        if (!svg) return []
        const paths = Array.from(svg.querySelectorAll<SVGPathElement>(sel))
        paths.forEach(p => { const l = p.getTotalLength(); gsap.set(p, { strokeDasharray: l, strokeDashoffset: l }) })
        gsap.to(paths, { strokeDashoffset: 0, duration: dur, stagger, ease: 'power2.out', delay: .2 })
        return paths
      }
      const paths = draw(art.current, '.jn-contour', .14, 2.2)
      gsap.from('.jn-node', { opacity: 0, y: 12, scale: .94, duration: .6, stagger: .22, delay: .9, ease: 'power2.out', clearProps: 'transform' })
      if (paths.length) gsap.to(paths, { y: (i: number) => (i % 2 ? 7 : -7), duration: 5.5, ease: 'sine.inOut', yoyo: true, repeat: -1, stagger: { each: .35, from: 'center' } })
      // the mountain is drawn line by line (first stroke ~1 s after the page is ready), then the water appears under it
      const ridges = Array.from(peak.current?.querySelectorAll<SVGPathElement>('.jn-ridge') ?? [])
      if (ridges.length) {
        ridges.forEach(p => { const l = p.getTotalLength(); gsap.set(p, { strokeDasharray: l, strokeDashoffset: l }) })
        gsap.set('.jn-wl', { opacity: 0 })
        ScrollTrigger.create({
          trigger: '.jn-mountain', start: 'top 92%', once: true,
          onEnter: () => {
            const tl = gsap.timeline({ delay: .8 })
            tl.to(ridges, { strokeDashoffset: 0, duration: 1.5, stagger: .22, ease: 'power2.inOut' })
              .to('.jn-wl', { opacity: (i: number) => [.5, .4, .3][i] ?? .3, duration: 1.2, stagger: .25, ease: 'sine.out' }, '>-.6')
          },
        })
      }
      // the ice falls from the peak, over and over, like the 08:37 collapse
      gsap.utils.toArray<SVGCircleElement>('.jn-flake').forEach((el, i) => {
        const tl = gsap.timeline({ repeat: -1, repeatDelay: 2.6, delay: 3.6 + i * 0.22 })
        tl.set(el, { y: 0, x: 0, opacity: 0 })
          .to(el, { opacity: .85, duration: .25, ease: 'none' })
          .to(el, { y: 120 + (i % 4) * 9, x: (i % 2 ? 1 : -1) * (8 + i * 2.4), duration: 2.2 + (i % 5) * .25, ease: 'power1.in' }, '<')
          .to(el, { opacity: 0, duration: .5 }, '>-.5')
      })
      gsap.utils.toArray<SVGPathElement>('.jn-wl').forEach((el, i) => gsap.to(el, { x: i % 2 ? -24 : 24, duration: 4 + i * 1.3, ease: 'sine.inOut', yoyo: true, repeat: -1 }))
      const glacier = root.current?.querySelector<HTMLElement>('.jn-glacier')
      const move = (e: PointerEvent) => {
        if (!glacier) return
        const r = glacier.getBoundingClientRect(), nx = (e.clientX - r.left) / r.width - .5, ny = (e.clientY - r.top) / r.height - .5
        gsap.to('.jn-mountain', { x: nx * -12, y: ny * -5, duration: .9, ease: 'power2.out' })
      }
      glacier?.addEventListener('pointermove', move)
      return () => glacier?.removeEventListener('pointermove', move)
      if (line.current) gsap.fromTo(line.current, { scaleX: 0 }, { scaleX: 1, ease: 'none', transformOrigin: 'left center', scrollTrigger: { trigger: line.current, start: 'top 88%', end: 'top 45%', scrub: .6, scroller: root.current! } })
    })
    ScrollTrigger.refresh()
    return () => media.revert()
  }, [])

  const go = (id: string) => () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  const R = pub?.river, G = pub?.gandak
  const attention = R ? [...new Map(R.flagged.filter(f => f.status !== 'RISING').sort((a, b) => (b.trend === 'rising' ? 1 : 0) - (a.trend === 'rising' ? 1 : 0)).map(f => [f.river, f])).values()].slice(0, 3) : []
  const flagged = R ? R.warning + R.danger : 0
  const tone = R?.danger ? 'danger' : R?.warning ? 'warning' : 'steady'

  return (
    <div className="jn-home" ref={root}>
      <header className="jn-nav">
        <button className="jn-brand" onClick={() => root.current?.scrollTo({ top: 0, behavior: 'smooth' })} aria-label="JalNetra home"><img src="/brand/jalnetra-logo.png" alt="JalNetra" height={40} /></button>
        <nav aria-label="Primary">
          <button onClick={go('how')}>How it works</button>
          <button onClick={onLive}>Live map</button>
          <button onClick={onStory}>Glacier Story</button>
          {onAws && <button onClick={onAws}>How AWS works</button>}
          <button onClick={go('safety')}>Safety</button>
          <button onClick={go('about')}>About</button>
        </nav>
        <Magnet><MovingBorderButton className="jn-nav-cta" onClick={onStory}>Start the walkthrough <FiArrowRight /></MovingBorderButton></Magnet>
      </header>

      <main>
        <section className="jn-glacier" data-reveal aria-labelledby="jn-glacier">
          <div className="jn-glacier-copy">
            <span className="jn-eyebrow">GLACIER STORY</span>
            <h2 id="jn-glacier">A minute-by-minute disaster replay.</h2>
            <p>Explore the 26 August 2026 Langtang Lirung glacier collapse with an interactive timeline, using the official timeline and satellite imagery.</p>
            <button className="jn-btn jn-btn-primary" onClick={onStory}>View Glacier Story <FiArrowRight /></button>
          </div>
          <div className="jn-mountain" aria-hidden="true">
            <svg ref={peak} className="jn-peak" viewBox="0 0 560 240" fill="none" preserveAspectRatio="xMaxYMax meet">
              <g className="jn-back"><path className="jn-ridge jn-ridge-far" d="M20 212L110 140L170 168L255 104L330 146L400 96L470 150L560 200" /><path className="jn-ridge jn-ridge-far" d="M255 104L246 150L270 212M400 96L392 150L416 212" /></g>
              <g className="jn-snow">{Array.from({ length: 12 }, (_, i) => <circle key={i} className="jn-flake" cx={296 + ((i * 7) % 30)} cy={34} r={1.5 + (i % 3) * 0.6} />)}</g>
              <path className="jn-ridge" d="M0 212L96 150L160 168L252 70L304 22L338 58L372 40L420 112L470 92L560 190" />
              <path className="jn-ridge" d="M304 22L290 84L318 120L304 212" />
              <path className="jn-ridge" d="M252 70L274 118L246 160L262 212" />
              <path className="jn-ridge" d="M338 58L330 112L356 150L346 212" />
              <path className="jn-ridge" d="M372 40L384 100L410 140L402 212" />
              <path className="jn-ridge" d="M96 150L132 186L120 212M420 112L446 168L432 212M160 168L190 196L182 212" />
              <g className="jn-water">
                <path className="jn-wl" d="M-40 218q35-7 70 0t70 0t70 0t70 0t70 0t70 0t70 0t70 0t70 0t70 0" />
                <path className="jn-wl" d="M-20 227q35-7 70 0t70 0t70 0t70 0t70 0t70 0t70 0t70 0t70 0t70 0" />
                <path className="jn-wl" d="M-60 236q35-7 70 0t70 0t70 0t70 0t70 0t70 0t70 0t70 0t70 0t70 0" />
              </g>
            </svg>
          </div>
          <ol className="jn-glacier-time" aria-label="Timeline">
            <li className="on"><i /><span><b>08:37</b><small>Glacier collapse (Langtang Lirung)</small></span></li>
            <li><i /></li><li><i /></li><li><i /></li>
          </ol>
        </section>

        <section className="jn-hero">
          <div className="jn-hero-copy">
            <span className="jn-mode"><b><i /> WATER DISASTER MANAGEMENT</b><span>Exercise mode · synthetic replay data for the Gandak</span></span>
            <h1><TextGenerateEffect lines={[{ text: 'Disaster management' }, { text: 'that leads' }, { text: 'to action.', accent: true }]} /></h1>
            <p className="jn-lede" data-reveal><strong>JalNetra is a water-disaster management system.</strong> It turns upstream river signals into local action: it predicts where flood water will go, shows the affected villages and a suggested evacuation route, and places a warning call <strong>only after a human approves it.</strong></p>
            <div className="jn-cta" data-reveal>
              <Magnet><button className="jn-btn jn-btn-primary" onClick={onStory}>Start the walkthrough <FiArrowRight /></button></Magnet>
              <button className="jn-btn" onClick={onLive}>Open the live map</button>
              <button className="jn-btn jn-btn-ghost" onClick={go('how')}><FiChevronDown /> How it works</button>
            </div>
          </div>

          <div className="jn-art" aria-hidden="true">
            <svg ref={art} viewBox="0 0 720 560" preserveAspectRatio="xMidYMid meet" fill="none">
              {[
                'M0 380C90 360 150 300 240 310C340 322 380 250 470 200C560 150 640 170 720 90',
                'M0 400C100 380 170 330 260 338C360 348 420 280 500 240C590 196 650 210 720 130',
                'M0 420C110 404 190 360 280 366C380 374 450 320 530 288C610 256 670 262 720 180',
                'M0 440C120 428 210 392 300 396C400 402 480 360 560 336C630 316 680 316 720 240',
                'M0 462C130 452 230 424 320 426C420 428 510 396 590 378C650 364 692 366 720 300',
                'M0 486C140 478 250 458 340 458C440 458 540 438 620 428C672 422 700 424 720 370',
              ].map((d, i) => <path key={i} className="jn-contour" d={d} strokeWidth={i === 2 ? 1.6 : 1} opacity={0.35 + (i % 3) * 0.18} />)}
            </svg>
            <span className="jn-node n1"><i /> Forecast</span>
            <span className="jn-node n2"><i /> Predict</span>
            <span className="jn-node n3"><i /> Plan</span>
            <span className="jn-node n4"><i /> Warn <small>(Human Approval)</small></span>
          </div>
        </section>

        <section className="jn-features" aria-label="What JalNetra does">
          {([
            [<FiBarChart2 key="a" />, 'River Watch', 'Monitors forecasts across river points', onRivers],
            [<MdWaves key="b" />, 'Flood Prediction', 'Shows inundation and evacuation routes', onMap],
            [<FiUser key="c" />, 'Human in the Loop', 'Calls only after explicit approval', undefined],
            [<FiFileText key="d" />, 'Public Feed', 'Read-only advisories (no personal details)', undefined],
          ] as const).map(([icon, t, d, fn]) => {
            const body = <><span className="jn-feature-icon">{icon}</span><span><b>{t}</b><small>{d}</small></span></>
            return fn
              ? <button key={t} className="jn-feature" data-reveal onClick={fn}>{body}</button>
              : <div key={t} className="jn-feature" data-reveal>{body}</div>
          })}
        </section>

        <section className="jn-section" id="how" aria-labelledby="jn-how">
          <div className="jn-head" data-reveal><span>HOW IT WORKS</span><h2 id="jn-how">From a gauge reading to a decision a person can stand behind.</h2></div>
          <div className="jn-flow">
            <div className="jn-flow-line" aria-hidden="true"><div ref={line} /></div>
            {FLOW.map(s => <div className="jn-step" key={s.n} data-reveal><span className="jn-step-n">{s.n}</span><h3>{s.t}</h3><p>{s.d}</p></div>)}
          </div>
        </section>

        <section className="jn-section" aria-labelledby="jn-mon">
          <div className="jn-head" data-reveal><span>PUBLIC MONITOR</span><h2 id="jn-mon">What the network shows right now.</h2></div>
          <CardSpotlight className="jn-monitor" data-reveal>
            <div className="jn-monitor-top"><span><i className="jn-live" /> Latest validated scan</span><time>{R ? fmtIST(R.created_at) : 'checking…'}</time></div>
            {!pub && !err && <div className="jn-monitor-state"><FiRefreshCw className="jn-spin" /> Loading verified signals…</div>}
            {err && <div className="jn-monitor-state">Monitor unavailable. No conditions are inferred.</div>}
            {R && <div className="jn-monitor-grid">
              <div>
                <p className="jn-kicker">India network · <CountUp to={R.points} /> points</p>
                <h3 className={`jn-headline ${tone}`}>{R.headline}</h3>
                <p className="jn-sub">{flagged ? `${flagged} points need attention in the latest validated scan.` : 'No river is rising to flood levels in the latest validated scan.'}</p>
                <div className="jn-breakdown-bar" aria-hidden="true">{([['normal', R.normal], ['rising', R.rising], ['warning', R.warning], ['danger', R.danger]] as const).map(([k, v]) => v > 0 && <i key={k} className={k} style={{ flexGrow: v }} />)}</div>
                <ul className="jn-counts">{([['Normal', R.normal, 'normal'], ['Rising', R.rising, 'rising'], ['Warning', R.warning, 'warning'], ['Danger', R.danger, 'danger']] as const).map(([label, v, k]) => <li key={k}><span className={`jn-key ${k}`} />{label}<b>{v}</b></li>)}</ul>
              </div>
              <div>
                {attention.length > 0
                  ? <ul className="jn-list">{attention.map(f => <li key={f.river + f.near}><span className={`jn-dot ${f.trend === 'rising' ? 'warn' : 'high'}`} /><span><b>{f.river}</b><small>{f.near} · {f.trend === 'rising' ? 'rising' : 'high, falling'}</small></span><FiArrowUpRight /></li>)}</ul>
                  : <div className="jn-monitor-state"><FiShield /> No unusual movement detected</div>}
                <div className="jn-monitor-foot"><span>Gandak village model</span><b>{G ? (G.at_risk ? `${G.at_risk} at risk` : 'No risk') : '—'}</b></div>
              </div>
            </div>}
          </CardSpotlight>
        </section>

        <section className="jn-section" id="safety" aria-labelledby="jn-safe">
          <div className="jn-head" data-reveal><span>SAFETY</span><h2 id="jn-safe">Built so a mistake is hard to make.</h2></div>
          <div className="jn-safety">
            {SAFETY.map(([t, d], i) => <CardSpotlight className="jn-guard" key={t} data-reveal><span>{String(i + 1).padStart(2, '0')}</span><h3>{t}</h3><p>{d}</p></CardSpotlight>)}
          </div>
        </section>

        <section className="jn-section jn-about" id="about" aria-labelledby="jn-about">
          <div className="jn-head" data-reveal><span>ABOUT</span><h2 id="jn-about">Disasters outrun the information about them.</h2></div>
          <p data-reveal>In September 2026 a glacier collapse in Nepal sent a surge down the Trishuli and Narayani into the Gandak and on to villages in Bihar. Forecasts, imagery and village data existed, but they were scattered. JalNetra puts them in one operator-ready view, from early warning through evacuation and response, and keeps a person in charge of every warning.</p>
          <div className="jn-cta" data-reveal><button className="jn-btn jn-btn-primary" onClick={onStory}>Start the walkthrough <FiArrowRight /></button><button className="jn-btn" onClick={onLive}>Open the live map</button>{onAws && <button className="jn-btn" onClick={onAws}>How AWS works</button>}</div>
        </section>
      </main>

      <footer className="jn-footer">
        <div className="jn-sources"><b>Data sources</b><ul>{DATA.map(d => <li key={d}>{d}</li>)}</ul></div>
        <p>JalNetra · Exercise data is synthetic replay and is not a real flood warning.</p>
      </footer>
    </div>
  )
}
