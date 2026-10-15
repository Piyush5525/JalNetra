import { useEffect, useState } from 'react'
import { BitmapLayer } from '@deck.gl/layers'
import { bounds, loadTerrain } from '../engine/terrain'
import { makeSpreadResult, spreadImage, type Horizon } from './model'
import { M } from '../live/shared'
import observedRadar from '../img/o2.png'

/**
 * Read-only map layer for the operator map. It is created only after the
 * operator asks to view the spread and has no incident or alert side effects.
 */
export function useFloodSpreadMapLayer(horizon: Horizon | null): any[] {
  const [layers, setLayers] = useState<any[]>([])

  useEffect(() => {
    let alive = true
    if (horizon === null) { setLayers([]); return () => { alive = false } }
    setLayers([])
    loadTerrain(M).then(terrain => {
      if (!alive) return
      const result = makeSpreadResult(terrain, horizon)
      const image = spreadImage(result)
      const mapBounds = bounds(terrain)
      setLayers([
        new BitmapLayer({ id: 'flood-spread-observed-sentinel1', image: observedRadar, bounds: mapBounds, opacity: 0.62, pickable: false }),
        new BitmapLayer({ id: 'flood-spread-preliminary', image, bounds: mapBounds, opacity: 0.68, pickable: false }),
      ])
    }).catch(() => { if (alive) setLayers([]) })
    return () => { alive = false }
  }, [horizon])

  return layers
}
