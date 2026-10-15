import MJ from '../model.json'
import type { Level, ModelParams, VillageRisk } from '../engine/core'
import type { Route } from '../engine/route'

export const M = MJ as unknown as ModelParams & { grid: { w: number; n: number; res: number; cols: number; rows: number }; pois: { n: string; a: string; x: number; y: number; h: number }[] }
export const VILLAGES = M.villages
export const VBY = new Map(VILLAGES.map(v => [v.id, v]))
export const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", Helvetica, Arial, sans-serif'
export const LEVEL_RGB: Record<Level, [number, number, number]> = { CRITICAL: [251, 113, 133], HIGH: [245, 158, 11], MEDIUM: [253, 224, 71], LOW: [100, 116, 139] }
export const LEVEL_HI: Record<Level, string> = { CRITICAL: 'अति गंभीर', HIGH: 'गंभीर', MEDIUM: 'मध्यम', LOW: 'कम' }
export const HLABEL: Record<number, string> = { 0: 'NOW', 3: '+3H', 6: '+6H', 12: '+12H', 24: '+24H' }

export const fmtIST = (t: number | string, withDate = true) => {
  const d = new Date(t)
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })
  return withDate ? `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}, ${time} IST` : time
}
export const fmtQ = (q: number) => Math.round(q).toLocaleString('en-IN')
export const impactText = (r: VillageRisk) => (r.impactH === null ? 'Not within 48 h' : r.impactH === 0 ? 'Now' : `~${r.impactH} h`)
export const windowText = (r: VillageRisk) => (!r.window ? 'Not within 48 h' : r.window[0] === 0 && r.window[1] === 0 ? 'Water predicted now' : `${r.window[0]}–${r.window[1]} hours`)

export function hindiAlert(name: string, r: VillageRisk, route: Route | null, simulated: boolean) {
  const when = r.impactH === null ? 'अगले दो दिनों में' : r.impactH === 0 ? 'अभी' : `लगभग ${r.impactH} घंटे में`
  const go = route ? `सुरक्षित जगह: ${route.shelter.n}, लगभग ${route.km.toFixed(1)} किलोमीटर। ${route.ok ? 'सुझाया गया रास्ता नदी पार नहीं करता और पानी वाले इलाके से बचता है।' : 'हर रास्ते में पानी आ सकता है, इसलिए पानी पहुँचने से पहले अभी निकलें।'}` : 'नज़दीकी ऊँची और सुरक्षित जगह पर जाएँ।'
  return `${simulated ? 'यह एक अभ्यास संदेश है। ' : ''}नमस्ते। यह जलनेत्र की बाढ़ चेतावनी है। हमारे अनुमान के अनुसार गंडक नदी का पानी ${when} ${name} तक पहुँच सकता है। खतरा: ${LEVEL_HI[r.level]}। ${go} कृपया बच्चों, बुज़ुर्गों और गर्भवती महिलाओं को सबसे पहले ले जाएँ और पंचायत को सूचित करें।`
}

/** The English twin of hindiAlert: same village, time, risk and safe place, so the call can say it after the Hindi. */
export function englishAlert(name: string, r: VillageRisk, route: Route | null, simulated: boolean) {
  const when = r.impactH === null ? 'within the next two days' : r.impactH === 0 ? 'right now' : `in about ${r.impactH} hours`
  const go = route ? `Safe place: ${route.shelter.n}, about ${route.km.toFixed(1)} kilometres away. ${route.ok ? 'The suggested route does not cross the river and avoids flooded ground.' : 'Every route may be flooded, so leave now, before the water arrives.'}` : 'Move to the nearest high and safe ground.'
  return `${simulated ? 'This is an exercise message. ' : ''}Hello. This is a JalNetra flood warning. Our forecast says Gandak river water may reach ${name} ${when}. Risk level: ${r.level.toLowerCase()}. ${go} Please move children, elderly people and pregnant women first, and inform the panchayat.`
}

/** Stage-2 message for a citizen inside the evacuation zone: one short, urgent line in Hindi, then English. */
export function citizenAlert(_name: string, _district: string | undefined, hours: number | null, shelter: string | null, _km: number | null, exercise: boolean) {
  const whenHi = hours === null ? 'जल्द ही' : hours === 0 ? 'अभी' : `लगभग ${hours} घंटे में`
  const whenEn = hours === null ? 'soon' : hours === 0 ? 'right now' : `in about ${hours} hours`
  return {
    hi: `बाढ़ का खतरा! आपके क्षेत्र में बाढ़ आ रही है और ${whenHi} पहुँचेगी। कृपया तुरंत ${shelter ?? 'नज़दीकी सुरक्षित ऊँची जगह'} पर पहुँचें।${exercise ? ' यह अभ्यास है।' : ''}`,
    en: `Flood alert! Flood is coming to your area and will arrive ${whenEn}. Please reach ${shelter ?? 'the nearest safe high ground'} immediately.${exercise ? ' This is an exercise.' : ''}`,
  }
}
