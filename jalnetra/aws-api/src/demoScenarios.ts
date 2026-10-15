// Fixed, versioned exercise scenarios for the JalNetra Conduct Demo.
//
// References only: village identity, coordinates, the simulated clock and model version.
// The backend deliberately stores NO flood geometry, risk scores, route coordinates or live
// observations. The frontend recomputes the prediction from (modelVersion, simulatedClock,
// villageId, horizonHours) using the existing model and terrain engine.
//
// Village ids/coordinates come from src/model.json (model version 2026.10-a), read-only.
// Pure data and string helpers: no Node or DOM imports.

export const SCENARIO_VERSION = "gandak-exercise-v1";
export const MODEL_VERSION = "2026.10-a";
/** Fixed simulated "now" seen by the model. Replayed September 2026 data, never real time. */
export const SIMULATED_CLOCK = "2026-09-27T06:00:00Z";
export const HORIZONS = [0, 3, 6, 12, 24] as const;
export type Horizon = (typeof HORIZONS)[number];

export const PUBLIC_BANNER = "EXERCISE / अभ्यास: not a real flood warning";
export const EXERCISE_NOTICE_HI = "यह एक अभ्यास संदेश है, वास्तविक बाढ़ चेतावनी नहीं।";
export const EXERCISE_NOTICE_EN = "EXERCISE ONLY. This is not a real flood warning.";

export type Scenario = {
  id: string;
  order: 1 | 2 | 3 | 4 | 5;
  villageId: number;
  villageName: string;
  district: string;
  lat: number;
  lng: number;
};

export const SCENARIOS: readonly Scenario[] = [
  { id: "gandak-ex-1", order: 1, villageId: 10820949, villageName: "Harpur", district: "Gopalganj", lat: 26.6099, lng: 84.399 },
  { id: "gandak-ex-2", order: 2, villageId: 10817005, villageName: "Barariha", district: "Pashchim Champaran", lat: 26.9202, lng: 84.1806 },
  { id: "gandak-ex-3", order: 3, villageId: 10820612, villageName: "Birwat Kundaulia", district: "Kushinagar", lat: 26.6686, lng: 84.362 },
  { id: "gandak-ex-4", order: 4, villageId: 10825537, villageName: "Manjhariya", district: "Gopalganj", lat: 26.4924, lng: 84.533 },
  { id: "gandak-ex-5", order: 5, villageId: 10826242, villageName: "Salehpur", district: "Gopalganj", lat: 26.422, lng: 84.6942 },
];

export type PredictionReference = {
  scenarioId: string;
  scenarioVersion: string;
  modelVersion: string;
  villageId: number;
  villageName: string;
  district: string;
  lat: number;
  lng: number;
  simulatedClock: string;
  dataBasis: "synthetic_replay";
  horizonHours: Horizon | null;
  predictionDigest: string | null;
};

export function findScenario(id: string): Scenario | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}

export function isHorizon(value: unknown): value is Horizon {
  return typeof value === "number" && (HORIZONS as readonly number[]).includes(value);
}

export function predictionReference(scenario: Scenario, horizonHours: Horizon | null, predictionDigest: string | null): PredictionReference {
  return {
    scenarioId: scenario.id,
    scenarioVersion: SCENARIO_VERSION,
    modelVersion: MODEL_VERSION,
    villageId: scenario.villageId,
    villageName: scenario.villageName,
    district: scenario.district,
    lat: scenario.lat,
    lng: scenario.lng,
    simulatedClock: SIMULATED_CLOCK,
    dataBasis: "synthetic_replay",
    horizonHours,
    predictionDigest,
  };
}

export function alertTitle(scenario: Scenario): string {
  return `EXERCISE: ${scenario.villageName} flood alert`;
}

/** Server-generated. The exercise notice is part of the template and cannot be removed or replaced by a caller. */
export function messageHi(scenario: Scenario): string {
  return `${EXERCISE_NOTICE_HI} नमस्ते। यह जलनेत्र का बाढ़ चेतावनी अभ्यास है। अभ्यास में गंडक नदी की बाढ़ के अनुमान के आधार पर ${scenario.villageName}, ${scenario.district} के लिए बाढ़ का खतरा माना गया है। असली स्थिति में बच्चों, बुज़ुर्गों और गर्भवती महिलाओं को सबसे पहले नज़दीकी ऊँची और सुरक्षित जगह ले जाया जाएगा और पंचायत को सूचित किया जाएगा। यह केवल अभ्यास है, कृपया घबराएँ नहीं।`;
}

export function messageEn(scenario: Scenario): string {
  return `${EXERCISE_NOTICE_EN} In this drill, a Gandak flood prediction on replayed September 2026 data is assumed for ${scenario.villageName}, ${scenario.district}. In a real event, children, elderly people and pregnant women would be moved first to the nearest safe high ground and the panchayat informed. Please do not panic: this is only a drill.`;
}
