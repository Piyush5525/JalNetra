import countries from './countries.json'

/**
 * Country outlines as lines, minus the straight edges that only exist because the source polygons were clipped to a box
 * (lng 80.5 to 88.5, lat 23.5 to 30). Drawn as strokes they looked like a stray square on the map.
 */
const CLIP = { w: 80.5, e: 88.5, s: 23.5, n: 30 }
const onClipEdge = (a: number[], b: number[]) => {
  const vertical = a[0] === b[0] && (a[0] === CLIP.w || a[0] === CLIP.e)
  const horizontal = a[1] === b[1] && (a[1] === CLIP.s || a[1] === CLIP.n)
  return (vertical && Math.abs(a[1] - b[1]) > 0.5) || (horizontal && Math.abs(a[0] - b[0]) > 0.5)
}

const rings = (g: any): number[][][] =>
  g.type === 'Polygon' ? g.coordinates : g.type === 'MultiPolygon' ? g.coordinates.flat() : g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : []

export const countryBorders: any = {
  type: 'FeatureCollection',
  features: ((countries as any).features as any[]).map(f => {
    const lines: number[][][] = []
    for (const ring of rings(f.geometry)) {
      let cur: number[][] = []
      for (let i = 0; i < ring.length; i++) {
        if (i > 0 && onClipEdge(ring[i - 1], ring[i])) { if (cur.length > 1) lines.push(cur); cur = [] }
        cur.push(ring[i])
      }
      if (cur.length > 1) lines.push(cur)
    }
    return { type: 'Feature', properties: f.properties ?? {}, geometry: { type: 'MultiLineString', coordinates: lines } }
  }),
}
