import { useState } from 'react'
import { FiAlertTriangle, FiCamera, FiPlay, FiRefreshCw, FiVolume2, FiX } from 'react-icons/fi'
import { checkPhoto, hindiRouteLine, speak, type PhotoVerdict, type Walk } from './aws'

/** One voice at a time: starting any Listen button stops whatever is already speaking. */
let playing: HTMLAudioElement | null = null
const stopPlaying = () => { if (playing) { playing.pause(); playing.currentTime = 0; playing = null } }

/** Plays the Hindi advisory with Amazon Polly (cached in S3, served by CloudFront). */
export function ListenButton({ text, onUrl, className = 'route-btn', lang = 'hi', short = false }: { text: string; onUrl?: (url: string) => void; className?: string; lang?: 'hi' | 'en'; short?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [url, setUrl] = useState('')
  const play = async () => {
    setBusy(true); setErr('')
    try {
      const s = url ? { url } : await speak(text, 'Kajal', lang)
      setUrl(s.url); onUrl?.(s.url)
      stopPlaying()
      const audio = new Audio(s.url)
      playing = audio
      audio.onended = () => { if (playing === audio) playing = null }
      await audio.play()
    } catch (e) { setErr((e as Error).message || 'Could not play the audio') }
    finally { setBusy(false) }
  }
  return (
    <span className="listen">
      <button className={className} onClick={() => void play()} disabled={busy}>{busy ? <FiRefreshCw className="spin" /> : <FiVolume2 />} {short ? (lang === 'en' ? 'English' : 'हिन्दी') : lang === 'en' ? 'Listen in English' : 'Listen in Hindi'}</button>
      {err && <small className="err"><FiAlertTriangle /> {err}</small>}
    </span>
  )
}

/** Real walking directions from Amazon Location Service. */
export function WalkSteps({ walk, loading, error, label = 'Walking' }: { walk: Walk | null; loading: boolean; error: string; label?: string }) {
  if (loading) return <p className="note"><FiRefreshCw className="spin" /> Getting walking directions…</p>
  if (error) return <p className="note dim">Walking directions unavailable: {error}</p>
  if (!walk) return null
  return (
    <div className="walk-steps">
      <div className="kicker">{label} directions · {walk.km.toFixed(1)} km · about {walk.minutes} min</div>
      <ol>{walk.steps.slice(0, 12).map((s, i) => <li key={i}><b>{s.text}</b><span>{s.minutes} min</span></li>)}</ol>
      <small>Route from {walk.source}. Roads and paths can be cut by water: confirm locally.</small>
    </div>
  )
}

/** Rekognition check for a citizen's photo. */
export function PhotoCheck({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState<PhotoVerdict | null>(null)
  const [err, setErr] = useState('')
  const [preview, setPreview] = useState('')
  const pick = async (file: File | undefined) => {
    if (!file) return
    setErr(''); setRes(null); setBusy(true)
    try {
      // shrink big phone photos in the browser so the upload stays small
      const bmp = await createImageBitmap(file)
      const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height))
      const c = document.createElement('canvas'); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale)
      c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
      const dataUrl = c.toDataURL('image/jpeg', 0.85)
      setPreview(dataUrl)
      setRes(await checkPhoto(dataUrl))
    } catch (e) { setErr((e as Error).message || 'Could not check this photo') }
    finally { setBusy(false) }
  }
  const tone = res?.verdict === 'likely' ? 'danger' : res?.verdict === 'possible' ? 'warn' : 'ok'
  return (
    <div className="photo-modal" role="dialog" aria-label="Check a flood photo">
      <div className="photo-card">
        <button className="x" onClick={onClose} aria-label="Close"><FiX /></button>
        <h2>Check a flood photo</h2>
        <p className="note">Upload a photo from a citizen report. Amazon Rekognition looks for flood water. It is a first screen, not proof.</p>
        <label className="route-btn primary photo-pick"><FiCamera /> Choose a photo<input type="file" accept="image/jpeg,image/png" capture="environment" onChange={e => void pick(e.target.files?.[0])} hidden /></label>
        {busy && <p className="note"><FiRefreshCw className="spin" /> Checking…</p>}
        {err && <p className="err"><FiAlertTriangle /> {err}</p>}
        {preview && <img className="photo-prev" src={preview} alt="Photo being checked" />}
        {res && <div className={`india-chip ${tone}`}><i />{res.verdict === 'likely' ? 'Flood water likely' : res.verdict === 'possible' ? 'Water visible, flooding possible' : 'No clear flood signal'} · flood {res.floodConfidence}% · water {res.waterConfidence}%</div>}
        {res && <ul className="photo-labels">{res.labels.slice(0, 8).map(l => <li key={l.name}>{l.name} <b>{l.confidence}%</b></li>)}</ul>}
        {res && <p className="note tight">{res.note}</p>}
      </div>
    </div>
  )
}

export { hindiRouteLine, FiPlay }
