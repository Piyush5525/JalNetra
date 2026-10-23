import { jsPDF } from 'jspdf'

/**
 * NDRF flood advisory report (PDF), built in the browser from the same model output the map shows.
 * No placeholder data: every number is passed in by the caller, and a missing measurement is shown as n/a. The rescue-resource figures are a planning
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
export type ReportShelter = { lat: number; lng: number; name: string; kind: string; km: number; dry: boolean }
export type ReportVillage = { name: string; lat: number; lng: number; level: string; probPct: number; arrivalH: number | null }
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
  route: { shelter: string; shelterLat: number; shelterLng: number; km: number; roadKm: number; ok: boolean; carMin: number | null; walkMin: number | null } | null
  shelters: ReportShelter[]
  villages: ReportVillage[]
  zoneBox: { w: number; e: number; s: number; n: number } | null
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

type RGB = [number, number, number]
type Cell = string | { t: string; url: string }
const BLUE: RGB = [29, 78, 216]
const PALE: RGB = [240, 246, 243]
const AMBER: RGB = [194, 120, 3]
const mapsPin = (lat: number, lng: number) => `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`
const mapsDir = (a: [number, number], b: [number, number], mode: 'driving' | 'walking' = 'driving') =>
  `https://www.google.com/maps/dir/?api=1&origin=${a[0].toFixed(6)},${a[1].toFixed(6)}&destination=${b[0].toFixed(6)},${b[1].toFixed(6)}&travelmode=${mode}`

export function buildNdrfPdfBytes(input: NdrfInput): { bytes: ArrayBuffer; filename: string } {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' })
  const W = 210, M = 14, CW = W - 2 * M
  let y = 0
  let page = 1
  let secNo = 0
  const id = `JN-${t(input.village.name).replace(/\W+/g, '').toUpperCase().slice(0, 8)}-${input.generatedAt.toISOString().slice(0, 16).replace(/\D/g, '')}`
  const vPos: [number, number] = [input.village.lat, input.village.lng]
  const villageUrl = mapsPin(...vPos)
  const zone = input.zoneBox
  const zoneCentre: [number, number] | null = zone ? [(zone.s + zone.n) / 2, (zone.w + zone.e) / 2] : null

  const footer = () => {
    doc.setFillColor(...GREEN); doc.rect(0, 291, W, 6, 'F')
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(255, 255, 255)
    doc.text(t(`JalNetra flood advisory ${id}  |  Model ${input.modelVersion}  |  Automated forecast: confirm on the ground`), M, 294.8)
    doc.text(`Page ${page}`, W - M, 294.8, { align: 'right' })
  }
  const newPage = () => { footer(); doc.addPage(); page++; y = 18 }
  const need = (h: number) => { if (y + h > 284) newPage() }
  const heading = (s: string) => {
    y += 4; need(16); secNo++
    doc.setFillColor(...GREEN); doc.circle(M + 3.4, y - 1.4, 3.4, 'F')
    doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(255, 255, 255)
    doc.text(String(secNo), M + 3.4, y - 0.1, { align: 'center' })
    doc.setFontSize(12.5); doc.setTextColor(...GREEN)
    doc.text(t(s), M + 9.5, y)
    y += 2.2
    doc.setDrawColor(...LINE); doc.setLineWidth(0.3); doc.line(M, y, W - M, y)
    y += 6
  }
  const para = (s: string, size = 9.5, color: RGB = INK, bold = false) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(size); doc.setTextColor(...color)
    const lines = doc.splitTextToSize(t(s), CW) as string[]
    for (const l of lines) { need(5); doc.text(l, M, y); y += size * 0.5 }
    y += 1.5
  }
  const link = (label: string, x: number, yy: number, url: string, size = 8.5, align: 'left' | 'right' = 'left') => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(size); doc.setTextColor(...BLUE)
    const w = doc.getTextWidth(label), x0 = align === 'right' ? x - w : x
    doc.text(label, x0, yy)
    doc.setDrawColor(...BLUE); doc.setLineWidth(0.2); doc.line(x0, yy + 0.7, x0 + w, yy + 0.7)
    doc.link(x0, yy - size * 0.38, w, size * 0.5, { url })
  }
  /** Pill-shaped button that opens a Google Maps link. */
  const button = (label: string, x: number, yy: number, url: string) => {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5)
    const w = doc.getTextWidth(label) + 9
    doc.setFillColor(...BLUE); doc.roundedRect(x, yy, w, 7.6, 3.8, 3.8, 'F')
    doc.setTextColor(255, 255, 255); doc.text(label, x + 4.5, yy + 5)
    doc.link(x, yy, w, 7.6, { url })
    return w
  }
  const kv = (rows: [string, Cell][], colW = 46) => {
    doc.setFontSize(9.5)
    for (const [k, v] of rows) {
      const txt = typeof v === 'string' ? v : v.t
      const lines = doc.splitTextToSize(t(txt), CW - colW - 4) as string[]
      need(lines.length * 4.6 + 2)
      doc.setFillColor(...PALE); doc.rect(M, y - 4.2, colW - 2, lines.length * 4.6 + 1.2, 'F')
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...MUTE); doc.text(t(k), M + 2, y)
      doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(...INK)
      lines.forEach((l, i) => doc.text(l, M + colW, y + i * 4.6))
      if (typeof v !== 'string') link(lines[0], M + colW, y, v.url, 9.5)
      y += lines.length * 4.6 + 1.6
    }
    y += 2
  }
  const table = (head: string[], rows: Cell[][], widths: number[], align: ('l' | 'r')[] = []) => {
    const rowH = 6.6
    const drawHead = () => {
      doc.setFillColor(...GREEN); doc.roundedRect(M, y - 4.6, CW, rowH, 1, 1, 'F')
      doc.setFont('helvetica', 'bold'); doc.setFontSize(8.5); doc.setTextColor(255, 255, 255)
      let x = M
      head.forEach((h, i) => { doc.text(t(h), align[i] === 'r' ? x + widths[i] - 2 : x + 2, y, { align: align[i] === 'r' ? 'right' : 'left' }); x += widths[i] })
      y += rowH
    }
    need(rowH * 3); drawHead()
    rows.forEach((r, ri) => {
      if (y + rowH > 284) { newPage(); drawHead() }
      if (ri % 2 === 0) { doc.setFillColor(244, 248, 246); doc.rect(M, y - 4.6, CW, rowH, 'F') }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5); doc.setTextColor(...INK)
      let x = M
      r.forEach((c, i) => {
        const raw = typeof c === 'string' ? c : c.t
        const s = (doc.splitTextToSize(t(raw), widths[i] - 4)[0] as string) ?? ''
        const right = align[i] === 'r'
        if (typeof c !== 'string') link(s, right ? x + widths[i] - 2 : x + 2, y, c.url, 8.5, right ? 'right' : 'left')
        else doc.text(s, right ? x + widths[i] - 2 : x + 2, y, { align: right ? 'right' : 'left' })
        x += widths[i]
      })
      y += rowH
    })
    doc.setDrawColor(...LINE); doc.setLineWidth(0.2); doc.line(M, y - 4.6, W - M, y - 4.6)
    y += 3
  }

  // ---- title band
  doc.setFillColor(...GREEN); doc.rect(0, 0, W, 38, 'F')
  doc.setFillColor(...RED); doc.rect(0, 38, W, 1.6, 'F')
  doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(21)
  doc.text('FLOOD ADVISORY REPORT', M, 16)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10)
  doc.text('For the National Disaster Response Force (NDRF) and the District Disaster Management Authority', M, 23.5)
  doc.setFontSize(8.5); doc.setTextColor(190, 225, 210)
  doc.text(t(`Report ${id}   |   Generated ${ist(input.generatedAt)}   |   JalNetra flood intelligence`), M, 31)
  y = 52

  // ---- situation card
  const lvlColor: RGB = input.risk.level === 'CRITICAL' ? RED : input.risk.level === 'HIGH' ? AMBER : GREEN
  doc.setFillColor(...PALE); doc.roundedRect(M, y - 6, CW, 50, 2.5, 2.5, 'F')
  doc.setFillColor(...lvlColor); doc.roundedRect(M, y - 6, 3, 50, 1.5, 1.5, 'F')
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(...INK)
  doc.text(t(`${input.village.name}${input.village.district ? ', ' + input.village.district : ''}`), M + 8, y + 2)
  const badge = `${input.risk.level} RISK`
  doc.setFontSize(10); const bw = doc.getTextWidth(badge) + 9
  doc.setFillColor(...lvlColor); doc.roundedRect(W - M - 4 - bw, y - 4, bw, 8, 4, 4, 'F')
  doc.setTextColor(255, 255, 255); doc.text(badge, W - M - 4 - bw / 2, y + 1.4, { align: 'center' })
  const arrive = input.risk.arrivalH === null ? 'Not within 24 h' : input.risk.arrivalH === 0 ? 'At the village now' : `About ${input.risk.arrivalH} h`
  const zonePeople = input.population.people
  const tiles: [string, string][] = [['Flood probability', `${input.risk.probPct}%`], ['Water reaches village', arrive], ['Model confidence', t(input.risk.conf)], ['People in evac. zone', zonePeople === null ? 'n/a' : `~${n0(zonePeople)}`]]
  const tw = (CW - 16 - 9) / 4
  tiles.forEach(([k, v], i) => {
    const x = M + 8 + i * (tw + 3)
    doc.setFillColor(255, 255, 255); doc.roundedRect(x, y + 7, tw, 17, 2, 2, 'F')
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTE); doc.text(k, x + 3, y + 12.5)
    doc.setFont('helvetica', 'bold'); doc.setFontSize(v.length > 14 ? 9.5 : 12.5); doc.setTextColor(...INK); doc.text(v, x + 3, y + 20)
  })
  doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.setTextColor(...lvlColor)
  const act = doc.splitTextToSize(t(`Recommended action: ${input.risk.action}`), CW - 16) as string[]
  doc.text(act.slice(0, 2), M + 8, y + 30)
  doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...MUTE)
  const base = input.source === 'live' ? 'Live forecast (GloFAS river model + Open-Meteo rain + terrain)' : `Replay of the September 2026 Gandak flood${input.dataClock ? ' at ' + ist(input.dataClock) : ''}`
  doc.text(t(`Data basis: ${base}`), M + 8, y + 38)
  y += 58

  // ---- location links
  heading('Affected location (Google Maps)')
  kv([
    ['Village', `${input.village.name}${input.village.district ? ', ' + input.village.district : ''}`],
    ['Coordinates', `${input.village.lat.toFixed(5)} N, ${input.village.lng.toFixed(5)} E`],
  ])
  need(24)
  let bx = M
  bx += button('Open village in Google Maps', bx, y - 3, villageUrl) + 3
  if (zoneCentre) bx += button('Open flood-zone centre', bx, y - 3, mapsPin(...zoneCentre)) + 3
  if (input.route) button('Directions to shelter', bx, y - 3, mapsDir(vPos, [input.route.shelterLat, input.route.shelterLng]))
  y += 9
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(...MUTE)
  doc.text(t(`Village: ${villageUrl}`), M, y); y += 4
  if (zoneCentre) { doc.text(t(`Flood-zone centre: ${mapsPin(...zoneCentre)}`), M, y); y += 4 }
  y += 4

  // ---- forecast table
  heading('Flood forecast and affected area')
  para(`Selected planning horizon: ${hz(input.selectedHorizon)}. The flood trajectory is the extra land the river covers beyond its normal channel; the evacuation zone is the region to keep empty (the flood now and at the next forecast step, with a safety margin).`, 9, MUTE)
  table(['Time', 'Flood trajectory (km2)', 'Evacuation zone (km2)', 'People in zone'],
    input.horizons.map(r => [hz(r.h) + (r.h === input.selectedHorizon ? '  (selected)' : ''), r.floodKm2.toLocaleString('en-IN'), r.evacKm2.toLocaleString('en-IN'), n0(r.people)]),
    [48, 44, 44, 46], ['l', 'r', 'r', 'r'])
  para(`People: ${input.population.source}. For horizons other than the selected one, people are scaled from the selected zone's density.`, 8.5, MUTE)

  // ---- map
  if (input.mapPng) {
    need(106)
    heading('Map of the affected area')
    doc.setDrawColor(...LINE); doc.setLineWidth(0.4); doc.roundedRect(M - 0.5, y - 0.5, CW + 1, 85, 1.5, 1.5)
    doc.addImage(input.mapPng, 'JPEG', M, y, CW, 84)
    y += 88
    const keys: [RGB, string][] = [[RED, 'Flood trajectory'], [[109, 40, 217], 'Evacuation zone'], [[22, 163, 74], 'Shelter, outside flood'], [[245, 158, 11], 'Shelter, inside flood'], [BLUE, 'Village']]
    let kx = M
    doc.setFont('helvetica', 'normal'); doc.setFontSize(8)
    for (const [c, lab] of keys) { doc.setFillColor(...c); doc.circle(kx + 1.6, y - 1, 1.6, 'F'); doc.setTextColor(...INK); doc.text(lab, kx + 5, y); kx += 6 + doc.getTextWidth(lab) + 5 }
    y += 7
  }

  // ---- villages
  heading(`Affected villages inside the evacuation zone (${input.villages.length})`)
  if (input.villages.length) {
    table(['Village', 'Risk level', 'Flood prob.', 'Water arrives', 'Location'],
      input.villages.slice(0, 30).map(v => [v.name, v.level, `${v.probPct}%`, v.arrivalH === null ? 'not in 48 h' : v.arrivalH === 0 ? 'now' : `~${v.arrivalH} h`, { t: 'Google Maps', url: mapsPin(v.lat, v.lng) }]),
      [62, 28, 26, 32, 34], ['l', 'l', 'r', 'r', 'l'])
    if (input.villages.length > 30) para(`${input.villages.length - 30} more villages not listed.`, 8.5, MUTE)
  } else para('No other tracked village lies inside the zone at this horizon.')

  // ---- shelters
  heading('Nearest shelters')
  table(['Shelter', 'Type', 'Distance', 'Flood status (+24 h)', 'Location'],
    input.shelters.map(s => [s.name || 'Unnamed', s.kind, `${s.km.toFixed(1)} km`, s.dry ? 'Outside predicted flood' : 'Inside predicted flood', { t: 'Google Maps', url: mapsPin(s.lat, s.lng) }]),
    [58, 22, 22, 46, 34], ['l', 'l', 'r', 'l', 'l'])
  para('Shelters are the nearest mapped schools, colleges and hospitals (OpenStreetMap). They are not confirmed relief camps; capacity and access must be verified.', 8.5, MUTE)

  // ---- route
  heading('Evacuation route')
  if (input.route) {
    const dest: [number, number] = [input.route.shelterLat, input.route.shelterLng]
    kv([
      ['Destination', { t: input.route.shelter, url: mapsPin(...dest) }],
      ['Distance', `${input.route.km.toFixed(1)} km (${input.route.roadKm.toFixed(1)} km on mapped roads)`],
      ['Travel time', `${input.route.carMin ?? 'n/a'} min by car, ${input.route.walkMin ?? 'n/a'} min on foot`],
      ['Flood exposure', input.route.ok ? 'Route avoids predicted flood water' : 'No fully dry route: least-exposed route, leave before the water arrives'],
    ])
    need(12)
    const w1 = button('Driving directions', M, y - 3, mapsDir(vPos, dest))
    button('Walking directions', M + w1 + 3, y - 3, mapsDir(vPos, dest, 'walking'))
    y += 10
  } else para('No dry school or hospital was found within 30 km without crossing the river.')

  // ---- resources
  const est = estimateResources(input.population.people, input.population.floodPeople)
  heading('Estimated rescue and relief requirement (planning estimate)')
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
  } else para('Measured population for the zone is not available, so no resource estimate is given.')

  // ---- alert status (only when a real decision exists)
  if (input.escalation) {
    heading('Local alert status')
    const s = input.escalation.status
    kv([['Village head (Sarpanch)', s === 'awaiting_sarpanch' ? 'Called, waiting for a decision' : s === 'rejected' ? 'Rejected as a false alarm' : s === 'expired' ? 'No decision in time' : 'Confirmed the alert'],
      ['Decision channel', input.escalation.via ?? 'n/a'],
      ['Citizens in the zone', s === 'escalated' || s === 'escalating' ? 'Alert call placed' : 'Not called']])
  }

  // ---- risk factors
  heading('Why this village is at risk')
  table(['Factor', 'Detail', 'Points'],
    input.risk.factors.map(f => [f.label, f.detail, `${Math.round(f.pts)}/${f.max}`]),
    [44, 106, 32], ['l', 'l', 'r'])
  para(`Risk score ${input.risk.score} of ${input.risk.factors.reduce((a, f) => a + f.max, 0)}.`, 9)

  // ---- method
  heading('Method, data and limits')
  para('River discharge forecast (GloFAS via Open-Meteo, 7 Gandak stations) is turned into a flood probability per 200 m cell with a model fitted to Sentinel-1 radar flood maps (height above channel from Copernicus DEM, JRC normal water). Only water connected to the river is kept. Population comes from WorldPop (100 m).', 8.8)
  para('Limits: the model says whether water reaches a place, not how deep. Embankments and canals are not modelled. Cells are about 200 m. It was fitted to one event (September 2026). Use alongside gauge readings and local reports.', 8.8)

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
