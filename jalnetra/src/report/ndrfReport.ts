import { jsPDF } from 'jspdf'

/**
 * NDRF flood advisory report (PDF), built in the browser from the same model output the map shows.
 * Nothing here is invented: every number is passed in by the caller. The rescue-resource figures are a planning
 * estimate from the stated assumptions and are labelled as such in the document.
 */

export const REPORT_ASSUMPTIONS = {
  /** Share of the people inside the flood trajectory who need assisted rescue (the rest leave on their own once warned). */
  shareNeedingRescue: 0.1,
  /** People one rescue boat can move in the evacuation window: 10 seats x 2 round trips per hour x 8 hours. */
  peoplePerBoat: 160,
  /** A rescue team of about 30 personnel works with 4 boats. */
  boatsPerTeam: 4,
  personnelPerTeam: 30,
  /** Share of the people in the zone who need a relief camp (the rest go to relatives or higher ground). */
  shareNeedingCamp: 0.4,
  /** People one relief camp (school building) can hold. */
  peoplePerCamp: 500,
  /** One medical team per this many people in the zone. */
  peoplePerMedicalTeam: 10_000,
} as const

export type ReportHorizon = { h: number; floodKm2: number; evacKm2: number; people: number | null; phones: number | null }
export type ReportShelter = { name: string; kind: string; km: number; dry: boolean }
export type ReportVillage = { name: string; level: string; probPct: number; arrivalH: number | null }
export type NdrfInput = {
  generatedAt: Date
  source: 'replay' | 'live'
  dataClock: Date | null
  modelVersion: string
  village: { name: string; district: string; lat: number; lng: number }
  risk: { level: string; probPct: number; score: number; conf: string; action: string; arrivalH: number | null; factors: { label: string; detail: string; pts: number; max: number }[] }
  selectedHorizon: number
  horizons: ReportHorizon[]
  population: { people: number | null; floodPeople: number | null; phones: number | null; source: string; phonesPerPerson: number }
  route: { shelter: string; km: number; roadKm: number; ok: boolean; carMin: number | null; walkMin: number | null } | null
  shelters: ReportShelter[]
  villages: ReportVillage[]
  escalation: { status: string; via: string | null } | null
  mapPng: string | null
}

const GREEN: [number, number, number] = [15, 61, 46]
const RED: [number, number, number] = [185, 28, 28]
const INK: [number, number, number] = [17, 24, 39]
const MUTE: [number, number, number] = [100, 116, 139]
const LINE: [number, number, number] = [215, 222, 230]

/** jsPDF's built-in fonts only cover Latin-1: map common symbols and drop the rest. */
const t = (s: string | number | null | undefined) => String(s ?? '')
  .replace(/[≈]/g, '~').replace(/[−–—]/g, '-').replace(/[→]/g, 'to').replace(/[≥]/g, '>=').replace(/[≤]/g, '<=')
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^ -ÿ]/g, '').replace(/\s+/g, ' ').trim()
const n0 = (v: number | null | undefined) => (v === null || v === undefined ? 'n/a' : Math.round(v).toLocaleString('en-IN'))
const ist = (d: Date) => d.toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' IST'
const hz = (h: number) => (h === 0 ? 'Now' : `+${h} h`)

/** Resource planning estimate from the people in the evacuation zone. */
export function estimateResources(people: number | null, floodPeople: number | null) {
  const A = REPORT_ASSUMPTIONS
  if (people === null || floodPeople === null) return null
  const rescue = Math.round(floodPeople * A.shareNeedingRescue)
  const boats = Math.max(1, Math.ceil(rescue / A.peoplePerBoat))
  const teams = Math.ceil(boats / A.boatsPerTeam)
  const camps = Math.ceil((people * A.shareNeedingCamp) / A.peoplePerCamp)
  return { rescue, boats, teams, personnel: teams * A.personnelPerTeam, camps, shelterPeople: Math.round(people * A.shareNeedingCamp), medical: Math.max(1, Math.ceil(people / A.peoplePerMedicalTeam)) }
}

export function buildNdrfPdfBytes(input: NdrfInput): { bytes: ArrayBuffer; filename: string } {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const W = 210, M = 14, CW = W - 2 * M
  let y = 0
  let page = 1
  const id = `JN-${t(input.village.name).replace(/\W+/g, '').toUpperCase().slice(0, 8)}-${input.generatedAt.toISOString().slice(0, 16).replace(/\D/g, '')}`

  const footer = () => {
    doc.setDrawColor(...LINE); doc.line(M, 285, W - M, 285)
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTE)
    doc.text(t(`JalNetra flood advisory ${id}  |  Model ${input.modelVersion}  |  Planning aid prepared by an automated forecast; confirm on the ground.`), M, 290)
    doc.text(`Page ${page}`, W - M, 290, { align: 'right' })
  }
  const newPage = () => { footer(); doc.addPage(); page++; y = 18 }
  const need = (h: number) => { if (y + h > 280) newPage() }
  const heading = (s: string) => {
    need(14)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...GREEN)
    doc.text(t(s), M, y); y += 1.8
    doc.setDrawColor(...GREEN); doc.setLineWidth(0.5); doc.line(M, y, M + 22, y); doc.setLineWidth(0.2)
    y += 5.5
  }
  const para = (s: string, size = 9.5, color: [number, number, number] = INK, bold = false) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size); doc.setTextColor(...color)
    const lines = doc.splitTextToSize(t(s), CW) as string[]
    for (const l of lines) { need(5); doc.text(l, M, y); y += size * 0.5 }
    y += 1.5
  }
  const kv = (rows: [string, string][], colW = 46) => {
    doc.setFontSize(9.5)
    for (const [k, v] of rows) {
      const lines = doc.splitTextToSize(t(v), CW - colW) as string[]
      need(lines.length * 4.6 + 1)
      doc.setFont('helvetica', 'normal'); doc.setTextColor(...MUTE); doc.text(t(k), M, y)
      doc.setFont('helvetica', 'bold'); doc.setTextColor(...INK)
      lines.forEach((l, i) => doc.text(l, M + colW, y + i * 4.6))
      y += lines.length * 4.6 + 1
    }
    y += 2
  }
  const table = (head: string[], rows: string[][], widths: number[], align: ('l' | 'r')[] = []) => {
    const rowH = 6.2
    const drawHead = () => {
      doc.setFillColor(...GREEN); doc.rect(M, y - 4.4, CW, rowH, 'F')
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(255, 255, 255)
      let x = M
      head.forEach((h, i) => { doc.text(t(h), align[i] === 'r' ? x + widths[i] - 2 : x + 2, y, { align: align[i] === 'r' ? 'right' : 'left' }); x += widths[i] })
      y += rowH
    }
    need(rowH * 3); drawHead()
    rows.forEach((r, ri) => {
      if (y + rowH > 280) { newPage(); drawHead() }
      if (ri % 2 === 0) { doc.setFillColor(244, 247, 250); doc.rect(M, y - 4.4, CW, rowH, 'F') }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...INK)
      let x = M
      r.forEach((c, i) => {
        const s = doc.splitTextToSize(t(c), widths[i] - 4)[0] as string
        doc.text(s ?? '', align[i] === 'r' ? x + widths[i] - 2 : x + 2, y, { align: align[i] === 'r' ? 'right' : 'left' }); x += widths[i]
      })
      y += rowH
    })
    y += 3
  }

  // ---- title band
  doc.setFillColor(...GREEN); doc.rect(0, 0, W, 34, 'F')
  doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(19)
  doc.text('FLOOD ADVISORY REPORT', M, 15)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10)
  doc.text('Prepared for the National Disaster Response Force (NDRF) and the District Disaster Management Authority', M, 22)
  doc.setFontSize(8.5)
  doc.text(t(`Report ${id}  |  Generated ${ist(input.generatedAt)}  |  Source: JalNetra flood intelligence`), M, 28.5)
  y = 44

  // ---- situation summary
  const lvlColor = input.risk.level === 'CRITICAL' ? RED : input.risk.level === 'HIGH' ? ([194, 120, 3] as [number, number, number]) : GREEN
  doc.setDrawColor(...lvlColor); doc.setLineWidth(0.8); doc.roundedRect(M, y - 4, CW, 30, 2, 2); doc.setLineWidth(0.2)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...INK)
  doc.text(t(`${input.village.name}${input.village.district ? ', ' + input.village.district : ''}`), M + 4, y + 3)
  doc.setFontSize(11); doc.setTextColor(...lvlColor)
  doc.text(`${input.risk.level} RISK`, W - M - 4, y + 3, { align: 'right' })
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(...INK)
  const arrive = input.risk.arrivalH === null ? 'not within 24 h' : input.risk.arrivalH === 0 ? 'already at the village' : `about ${input.risk.arrivalH} h`
  doc.text(t(`Flood probability ${input.risk.probPct}%  |  Water reaches the village: ${arrive}  |  Confidence: ${input.risk.conf}`), M + 4, y + 11)
  doc.text(t(`Coordinates ${input.village.lat.toFixed(4)} N, ${input.village.lng.toFixed(4)} E  |  Recommended action: ${input.risk.action}`), M + 4, y + 17)
  const base = input.source === 'live' ? 'Live forecast (GloFAS river model + Open-Meteo rain + terrain)' : `Replay of the September 2026 Gandak flood${input.dataClock ? ' at ' + ist(input.dataClock) : ''}`
  doc.setTextColor(...MUTE); doc.setFontSize(8.5)
  doc.text(t(`Data basis: ${base}`), M + 4, y + 23)
  y += 36

  // ---- forecast table
  heading('1. Flood forecast and affected area')
  para(`Selected planning horizon: ${hz(input.selectedHorizon)}. The flood trajectory is the extra land the river covers beyond its normal channel; the evacuation zone is the region to keep empty (the flood now and at the next forecast step, with a safety margin).`, 9, MUTE)
  table(['Time', 'Flood trajectory (km2)', 'Evacuation zone (km2)', 'People in zone', 'Phones in zone'],
    input.horizons.map(r => [hz(r.h) + (r.h === input.selectedHorizon ? '  (selected)' : ''), r.floodKm2.toLocaleString('en-IN'), r.evacKm2.toLocaleString('en-IN'), n0(r.people), n0(r.phones)]),
    [38, 38, 38, 34, 34], ['l', 'r', 'r', 'r', 'r'])
  para(`People: ${input.population.source}. Phones = people x ${input.population.phonesPerPerson} (assumption). For horizons other than the selected one, people are scaled from the selected zone's density.`, 8.5, MUTE)

  // ---- map
  if (input.mapPng) {
    need(98)
    heading('2. Map of the affected area')
    doc.addImage(input.mapPng, 'JPEG', M, y, CW, 84)
    y += 87
    para('Red: flood trajectory. Violet: evacuation zone. Green markers: shelters outside the predicted flood. Orange markers: shelters inside it. Blue star: the village.', 8.5, MUTE)
  }

  // ---- villages
  heading(`${input.mapPng ? '3' : '2'}. Affected villages inside the evacuation zone (${input.villages.length})`)
  if (input.villages.length) {
    table(['Village', 'Risk level', 'Flood probability', 'Water arrives'],
      input.villages.slice(0, 30).map(v => [v.name, v.level, `${v.probPct}%`, v.arrivalH === null ? 'not in 48 h' : v.arrivalH === 0 ? 'now' : `~${v.arrivalH} h`]),
      [78, 34, 36, 34], ['l', 'l', 'r', 'r'])
    if (input.villages.length > 30) para(`${input.villages.length - 30} more villages not listed.`, 8.5, MUTE)
  } else para('No other tracked village lies inside the zone at this horizon.')

  // ---- shelters
  heading(`${input.mapPng ? '4' : '3'}. Nearest shelters`)
  table(['Shelter', 'Type', 'Distance', 'Flood status (+24 h)'],
    input.shelters.map(s => [s.name || 'Unnamed', s.kind, `${s.km.toFixed(1)} km`, s.dry ? 'Outside predicted flood' : 'Inside predicted flood']),
    [78, 32, 26, 46], ['l', 'l', 'r', 'l'])
  para('Shelters are the nearest mapped schools, colleges and hospitals (OpenStreetMap). They are not confirmed relief camps; capacity and access must be verified.', 8.5, MUTE)

  // ---- route
  heading(`${input.mapPng ? '5' : '4'}. Evacuation route`)
  if (input.route) {
    kv([
      ['Destination', input.route.shelter],
      ['Distance', `${input.route.km.toFixed(1)} km (${input.route.roadKm.toFixed(1)} km on mapped roads)`],
      ['Travel time', `${input.route.carMin ?? 'n/a'} min by car, ${input.route.walkMin ?? 'n/a'} min on foot`],
      ['Flood exposure', input.route.ok ? 'Route avoids predicted flood water' : 'No fully dry route: least-exposed route, leave before the water arrives'],
    ])
  } else para('No dry school or hospital was found within 30 km without crossing the river.')

  // ---- resources
  const est = estimateResources(input.population.people, input.population.floodPeople)
  heading(`${input.mapPng ? '6' : '5'}. Estimated rescue and relief requirement (planning estimate)`)
  if (est) {
    const A = REPORT_ASSUMPTIONS
    kv([
      ['People in evacuation zone', `~${n0(input.population.people)}`],
      ['People inside the flood', `~${n0(input.population.floodPeople)}`],
      ['Needing assisted rescue', `~${n0(est.rescue)}  (${Math.round(A.shareNeedingRescue * 100)}% of those inside the flood)`],
      ['Rescue boats', `${est.boats}  (1 boat per ${A.peoplePerBoat} people over the window)`],
      ['NDRF rescue teams', `${est.teams}  (about ${est.personnel} personnel; ${A.boatsPerTeam} boats per team of ${A.personnelPerTeam})`],
      ['Relief camps', `${est.camps}  (for ~${n0(est.shelterPeople)} people, ${Math.round(A.shareNeedingCamp * 100)}% of the zone, ${A.peoplePerCamp} per camp)`],
      ['Medical teams', `${est.medical}  (1 per ${n0(A.peoplePerMedicalTeam)} people)`],
    ], 52)
    para('These figures follow from the assumptions in brackets and are a starting point for the response commander, not a deployment order.', 8.5, MUTE)
  } else para('Population in the zone is not available, so no estimate is given.')

  // ---- alert status
  heading(`${input.mapPng ? '7' : '6'}. Local alert status`)
  if (input.escalation) {
    const s = input.escalation.status
    kv([['Village head (Sarpanch)', s === 'awaiting_sarpanch' ? 'Called, waiting for a decision' : s === 'rejected' ? 'Rejected as a false alarm' : s === 'expired' ? 'No decision in time' : 'Confirmed the alert'],
      ['Decision channel', input.escalation.via ?? 'n/a'],
      ['Citizens in the zone', s === 'escalated' || s === 'escalating' ? 'Alert call placed' : 'Not called']])
  } else para('No alert has been approved for this village yet.')

  // ---- risk factors
  heading(`${input.mapPng ? '8' : '7'}. Why this village is at risk`)
  table(['Factor', 'Detail', 'Points'],
    input.risk.factors.map(f => [f.label, f.detail, `${Math.round(f.pts)}/${f.max}`]),
    [44, 106, 32], ['l', 'l', 'r'])
  para(`Risk score ${input.risk.score} of ${input.risk.factors.reduce((a, f) => a + f.max, 0)}.`, 9)

  // ---- method
  heading(`${input.mapPng ? '9' : '8'}. Method, data and limits`)
  para('River discharge forecast (GloFAS via Open-Meteo, 7 Gandak stations) is turned into a flood probability per 200 m cell with a model fitted to Sentinel-1 radar flood maps (height above channel from Copernicus DEM, JRC normal water). Only water connected to the river is kept. Population comes from WorldPop (100 m).', 8.8)
  para('Limits: the model says whether water reaches a place, not how deep. Embankments and canals are not modelled. Cells are about 200 m. It was fitted to one event (September 2026). Phone counts are estimates, not device locations. Use alongside gauge readings and local reports.', 8.8)

  footer()
  const bytes = doc.output('arraybuffer')
  return { bytes, filename: `NDRF-flood-advisory-${t(input.village.name).replace(/\W+/g, '-')}-${input.generatedAt.toISOString().slice(0, 10)}.pdf` }
}

/** Browser use: the same report as a Blob. */
export function buildNdrfReport(input: NdrfInput): { blob: Blob; filename: string } {
  const { bytes, filename } = buildNdrfPdfBytes(input)
  return { blob: new Blob([bytes], { type: 'application/pdf' }), filename }
}

// ---------------------------------------------------------------------------------------------------------------------
// Map image
// ---------------------------------------------------------------------------------------------------------------------
type Pt = [number, number]
export function renderReportMap(opts: {
  village: Pt
  flood: Pt[][][]       // polygons -> rings -> [lng, lat]
  evac: Pt[][][]
  shelters: { p: Pt; dry: boolean; name: string }[]
  river?: Pt[][]
}): string | null {
  const pts: Pt[] = [opts.village, ...opts.shelters.map(s => s.p), ...opts.evac.flatMap(p => p[0] ?? [])]
  if (!pts.length) return null
  const lngs = pts.map(p => p[0]), lats = pts.map(p => p[1])
  let x0 = Math.min(...lngs), x1 = Math.max(...lngs), y0 = Math.min(...lats), y1 = Math.max(...lats)
  const padX = (x1 - x0) * 0.08 + 0.01, padY = (y1 - y0) * 0.08 + 0.01
  x0 -= padX; x1 += padX; y0 -= padY; y1 += padY
  const W = 1500, H = 840
  const kx = Math.cos(((y0 + y1) / 2) * Math.PI / 180)
  const sc = Math.min(W / ((x1 - x0) * kx), H / (y1 - y0))
  const ox = (W - (x1 - x0) * kx * sc) / 2, oy = (H - (y1 - y0) * sc) / 2
  const px = (p: Pt): Pt => [ox + (p[0] - x0) * kx * sc, H - oy - (p[1] - y0) * sc]
  const c = document.createElement('canvas'); c.width = W; c.height = H
  const g = c.getContext('2d')
  if (!g) return null
  g.fillStyle = '#eef3ee'; g.fillRect(0, 0, W, H)
  // light grid
  g.strokeStyle = '#d9e2d9'; g.lineWidth = 1
  for (let i = 1; i < 10; i++) { g.beginPath(); g.moveTo((W / 10) * i, 0); g.lineTo((W / 10) * i, H); g.stroke(); g.beginPath(); g.moveTo(0, (H / 6) * (i % 6)); g.lineTo(W, (H / 6) * (i % 6)); g.stroke() }
  for (const r of opts.river ?? []) { g.strokeStyle = '#93c5fd'; g.lineWidth = 4; g.beginPath(); r.forEach((p, i) => { const q = px(p); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]) }); g.stroke() }
  const poly = (polys: Pt[][][], fill: string, stroke: string, lw: number) => {
    for (const rings of polys) {
      g.beginPath()
      for (const ring of rings) { ring.forEach((p, i) => { const q = px(p); i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1]) }); g.closePath() }
      g.fillStyle = fill; g.fill('evenodd'); g.strokeStyle = stroke; g.lineWidth = lw; g.stroke()
    }
  }
  poly(opts.evac, 'rgba(124,58,237,0.20)', '#6d28d9', 3)
  poly(opts.flood, 'rgba(220,38,38,0.32)', '#b91c1c', 3)
  for (const s of opts.shelters) {
    const q = px(s.p)
    g.fillStyle = s.dry ? '#16a34a' : '#f59e0b'; g.strokeStyle = '#ffffff'; g.lineWidth = 3
    g.beginPath(); g.arc(q[0], q[1], 11, 0, Math.PI * 2); g.fill(); g.stroke()
  }
  // village star
  const v = px(opts.village)
  g.fillStyle = '#1d4ed8'; g.strokeStyle = '#ffffff'; g.lineWidth = 3
  g.beginPath()
  for (let i = 0; i < 10; i++) { const r = i % 2 ? 9 : 20, a = (Math.PI / 5) * i - Math.PI / 2; g.lineTo(v[0] + Math.cos(a) * r, v[1] + Math.sin(a) * r) }
  g.closePath(); g.fill(); g.stroke()
  // scale bar (5 km) and north arrow
  // pixels per km: sc is pixels per degree of latitude (111.32 km)
  const kmPx = sc / 111.32
  g.fillStyle = '#111827'; g.fillRect(40, H - 50, kmPx * 5, 8)
  g.font = 'bold 26px Helvetica, Arial, sans-serif'; g.fillText('5 km', 40, H - 58)
  g.fillText('N', W - 60, 56); g.beginPath(); g.moveTo(W - 52, 66); g.lineTo(W - 62, 96); g.lineTo(W - 42, 96); g.closePath(); g.fill()
  g.strokeStyle = '#94a3b8'; g.lineWidth = 3; g.strokeRect(1.5, 1.5, W - 3, H - 3)
  return c.toDataURL('image/jpeg', 0.86)
}
