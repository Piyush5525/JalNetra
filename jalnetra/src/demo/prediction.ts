import { eventInputs, HORIZONS, runModel, type ModelParams, type ModelRun } from '../engine/core'
import type { DemoPredictionReference } from './types'

export const SCENARIO_VERSION = 'gandak-exercise-v1'
export const MODEL_VERSION = '2026.10-a'
export const SIMULATED_CLOCK = '2026-09-27T06:00:00Z'

export const EXERCISE_VILLAGES = {
  'gandak-ex-1': { id: 10820949, name: 'Harpur', lat: 26.6099, lng: 84.399 },
  'gandak-ex-2': { id: 10817005, name: 'Barariha', lat: 26.9202, lng: 84.1806 },
  'gandak-ex-3': { id: 10820612, name: 'Birwat Kundaulia', lat: 26.6686, lng: 84.362 },
  'gandak-ex-4': { id: 10825537, name: 'Manjhariya', lat: 26.4924, lng: 84.533 },
  'gandak-ex-5': { id: 10826242, name: 'Salehpur', lat: 26.422, lng: 84.6942 },
} as const

type Validation =
  | { ok: true; reference: DemoPredictionReference; village: ModelParams['villages'][number] }
  | { ok: false; error: string }

/** Validate server references against the bundled exercise before any model work. */
export function validatePredictionReference(value: unknown, model: ModelParams): Validation {
  const fail = (message: string): Validation => ({ ok: false, error: `Prediction unavailable: ${message}` })
  if (!value || typeof value !== 'object') return fail('missing exercise reference.')
  const ref = value as DemoPredictionReference
  if (ref.scenarioVersion !== SCENARIO_VERSION) return fail('unsupported scenario version.')
  if (ref.modelVersion !== MODEL_VERSION || model.version !== MODEL_VERSION) return fail('the referenced model does not match the bundled model version.')
  if (ref.simulatedClock !== SIMULATED_CLOCK) return fail('the replay clock does not match this fixed exercise.')
  if (ref.dataBasis !== 'synthetic_replay') return fail('this map supports bundled historical replay only.')
  if (typeof ref.scenarioId !== 'string' || !Object.hasOwn(EXERCISE_VILLAGES, ref.scenarioId)) return fail('unknown exercise scenario.')
  const expected = EXERCISE_VILLAGES[ref.scenarioId as keyof typeof EXERCISE_VILLAGES]
  if (ref.villageId !== expected.id || ref.villageName !== expected.name || ref.lat !== expected.lat || ref.lng !== expected.lng) {
    return fail('the village identity or coordinates do not belong to this scenario.')
  }
  const village = model.villages.find(v => v.id === expected.id)
  if (!village || village.name !== expected.name || village.lat !== expected.lat || village.lng !== expected.lng || ref.district !== village.district) {
    return fail('the village is not a matching member of the bundled model.')
  }
  if (ref.horizonHours !== null && !(HORIZONS as readonly unknown[]).includes(ref.horizonHours)) return fail('unsupported referenced horizon.')
  // No digest specification is available. Do not silently claim server/client parity.
  if (ref.predictionDigest !== null) return fail('a prediction digest was supplied, but this client cannot validate it. Approval readiness is blocked.')
  return { ok: true, reference: ref, village }
}

const runs = new WeakMap<ModelParams, ModelRun>()

/** DOM/network-free computation, shared by every village at the one validated replay clock. */
export function computePrediction(value: unknown, model: ModelParams) {
  const validation = validatePredictionReference(value, model)
  if (validation.ok === false) throw new Error(validation.error)
  let run = runs.get(model)
  if (!run) {
    run = runModel(model, eventInputs(model, Date.parse(validation.reference.simulatedClock)))
    runs.set(model, run)
  }
  const risk = run.villages.find(v => v.id === validation.village.id)
  if (!risk || HORIZONS.some(h => !Number.isFinite(risk.pAt[h]))) throw new Error('Prediction unavailable: model output is incomplete.')
  return { run, risk, village: validation.village }
}

/** Routing always considers water NOW ∪ +24 h, independent of the displayed horizon. */
export function unionRouteWater(now: { mask: Uint8Array; prob: Uint8Array }, later: { mask: Uint8Array; prob: Uint8Array }) {
  if (now.mask.length !== later.mask.length || now.prob.length !== now.mask.length || later.prob.length !== now.mask.length) {
    throw new Error('Prediction unavailable: inconsistent terrain masks.')
  }
  const mask = new Uint8Array(now.mask.length), prob = new Uint8Array(now.mask.length)
  for (let i = 0; i < mask.length; i++) {
    mask[i] = now.mask[i] === 2 || later.mask[i] === 2 ? 2 : now.mask[i] || later.mask[i] ? 1 : 0
    prob[i] = Math.max(now.prob[i], later.prob[i])
  }
  return { mask, prob }
}
