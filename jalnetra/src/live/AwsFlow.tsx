import { AppBrand } from '../components/AppBrand'

/** How JalNetra runs on AWS, as a 3D scene: letters travelling between mailboxes. The scene itself is the standalone /aws-flow.html. */
export default function AwsFlow({ onHome, onLive }: { onHome: () => void; onLive: () => void }) {
  return (
    <div className="aws-flow">
      <iframe src="/aws-flow.html" title="How JalNetra runs on AWS" allow="autoplay" />
      <div className="aws-flow-bar">
        <AppBrand onClick={onHome} />
        <button className="aws-flow-btn" onClick={onLive}>Open the live map</button>
      </div>
    </div>
  )
}
