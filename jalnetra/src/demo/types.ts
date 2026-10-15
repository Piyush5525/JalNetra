/** Contract agreed with the separate backend implementation; no production incidents. */
export type Horizon = 0 | 3 | 6 | 12 | 24
export type CallStatus = 'not_requested' | 'dispatching' | 'dispatched' | 'failed' | 'not_configured' | 'unknown'
export interface DemoPredictionReference {
  scenarioId: string
  scenarioVersion: string
  modelVersion: string
  villageId: number
  villageName: string
  district: string
  lat: number
  lng: number
  simulatedClock: string
  dataBasis: 'synthetic_replay'
  horizonHours: Horizon | null
  predictionDigest: string | null
}
export interface DemoAlert {
  id: string
  order: 1 | 2 | 3 | 4 | 5
  title: string
  exercise: true
  messageHi: string
  messageEn: string
  prediction: DemoPredictionReference
  approvalStatus: 'pending' | 'approved'
  approvedAt: string | null
  approvedBy: string | null
  callStatus: CallStatus
  callAttempts: 0 | 1
  callUpdatedAt: string | null
  callNote: string | null
}
export interface DemoAllowance {
  callsUsed: number
  callsMax: number
  cooldownSeconds: number
  nextCallAllowedAt: string | null
}
export interface DemoSession {
  id: string
  createdAt: string
  createdBy: string
  scenarioVersion: string
  exercise: true
  demoDestination: { configured: boolean; masked: string | null; provider: 'omnidimension' | 'twilio' | 'not_configured' }
  allowance: DemoAllowance
  alerts: DemoAlert[]
}
export interface DemoApprovalResult {
  replayed: boolean
  alert: DemoAlert
  session: Pick<DemoSession, 'allowance'>
}
export interface PublicDemoFeed {
  exercise: true
  banner: 'EXERCISE / अभ्यास: not a real flood warning'
  sessionId: string
  generatedAt: string
  items: Array<Pick<DemoAlert, 'id' | 'order' | 'title' | 'messageHi' | 'messageEn' | 'prediction'> & {
    approvedAt: string
    demoCall: 'dispatched' | 'not_confirmed'
  }>
}
