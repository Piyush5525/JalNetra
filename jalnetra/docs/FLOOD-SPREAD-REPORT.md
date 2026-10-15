# JalNetra: Flood Spread, Flood-Zone Polygon and Device Alerting

Technical report for the exercise towns (Harpur, Manjhariya, Barariha, Birwat Kundaulia, Salehpur).
Model version 2026.10-a. Scenario: replay of the real September 2026 Gandak flood.

---

## 1. What the feature does

1. Takes the river discharge forecast for the Gandak and converts it into a predicted **flooded area** around a town.
2. Draws the **flood trajectory polygon** (red): the extra land the flooded river covers beyond the normal channel,
   for NOW, +3 h, +6 h, +12 h and +24 h.
3. Draws a second, different polygon, the **evacuation zone** (violet): the region that should be kept empty while the
   flood passes. It is the flood at the selected time and at the next forecast step, widened by a safety margin.
4. Estimates the **people and mobile phones inside the evacuation zone** and draws phone icons only there.
5. Each polygon and the phones have a checkbox, so each can be shown or hidden.
6. A **simulated broadcast** turns the phone icons green as they are notified. Nothing is called or messaged.

Data source switch: **Replay (September 2026 flood)** or **Live forecast** (available when the live river feed works).
Everything is labelled as an exercise when it runs on replayed data. It is not a live flood warning.

---

## 2. Technical approach (pipeline)

```
GloFAS discharge + rain -> river forecast per station -> per-cell flood probability
   -> keep cells connected to the river -> subtract normal channel
   -> flood trajectory polygon  -> + next forecast step + safety margin -> evacuation zone polygon
   -> WorldPop population inside the evacuation zone -> x phones per person -> phones
```

| Step | Method | Code |
|---|---|---|
| River forecast | Damped trend + upstream routing + rain response, blended with GloFAS | `src/engine/core.ts` `forecast()` |
| Flood probability per cell | Logistic model on discharge, height above channel, distance to river | `pixelP()` |
| Flooded cells | probability >= p* | `src/engine/terrain.ts` `extentAt()` |
| Connectivity | 4-neighbour flood fill from river cells; isolated pockets removed | `src/floodSpread/connectivity.ts` |
| River reach | Cells within +-8 km of the village along the river (chainage), to the natural edge of the flood | `src/floodSpread/townSpread.ts` `windowOf()` |
| Arrival time and facts | Hourly evaluation, water within 1 km of the village | `src/floodSpread/townSpread.ts` |
| Polygons | Boundary tracing of flooded cells, hole filling, simplification, smoothing | `src/floodSpread/zone.ts` `townZone()` |
| Population | WorldPop stats API (100 m grid) summed inside the polygon, through JalNetra's cached proxy | `src/floodSpread/population.ts`, `aws-api/src/proxy.ts` |
| Phones | Population x phones per person; icons placed near mapped villages inside the zone | `src/floodSpread/zone.ts` `placePhones()` |

---

## 3. Parameters

### 3.1 Scenario and inputs

| Parameter | Value |
|---|---|
| Replay clock | 27 Sep 2026, 12:00 UTC (flood front still upstream, reaches all towns within 24 h) |
| Horizons | NOW, +3, +6, +12, +24 h |
| River discharge | GloFAS v4 through Open-Meteo, 7 stations: Devghat, Valmikinagar, Bagaha, Dumariaghat, Rewaghat, Lalganj, Hajipur |
| Rain | Open-Meteo / ERA5, 4 points in the Nepal catchment, averaged |
| Terrain | Copernicus DEM, expressed as HAND (height above nearest drainage), -5 to 25 m |
| Grid | 0.0018 degrees, about 200 m per cell (1111 x 1333 cells); covers 15 km either side of the river |
| Normal river | JRC permanent surface water |

### 3.2 River forecast (`forecast()`)

| Parameter | Value | Meaning |
|---|---|---|
| Trend slope | (Q0 - Q 12 h ago) / 12 | Current rise or fall rate |
| Trend damping tau | 10 h | Trend fades out exponentially |
| Trend weight | 0.5 at Devghat, 0.35 downstream | |
| Rain response kappa | 15 m3/s per mm | Fitted to Devghat, Sept 2026 |
| Rain peak delay tp | 36 h | Gamma-shaped response |
| Wave celerity | 6.78 km/h | Lag between stations |
| Routing weight | 0.65 | Share of the lagged upstream change applied downstream |
| GloFAS blend | w = exp(-h/18) | Local model early, GloFAS later |
| Uncertainty band | 4 % + 0.6 % per hour, plus model/GloFAS gap | Low and high bounds |
| Flow used for flooding | highest flow in the previous 72 h | Flood water stays after the peak passes |

### 3.3 Flood probability per cell

```
P = logistic( -7.605 + 12.023 * ln(Q / 4000) - 0.232 * HAND - 0.307 * dist )
```

- Q: discharge (m3/s) at the cell river chainage. HAND: height above nearest channel in metres. dist: distance to the river in km.
- A cell is flooded if **P >= 0.15** (p*).
- Coefficients were fitted to three Sentinel-1 radar flood maps (Sept to Oct 2026).

### 3.4 Polygons

| Parameter | Value |
|---|---|
| River reach | +-8 km of river chainage around the village (16 km), laterally to the edge of the flood |
| Connectivity | 4-neighbour, from river cells; no distance or radius rule |
| "Water reaches the town" | connected flood water within 1 km of the village point |
| Arrival evaluation | hourly to 12 h, then every 3 h to 24 h |
| Hole filling / islands | dry holes under 60 cells (about 2.4 km2) filled; flooded islands under 8 cells dropped |
| Outline | Douglas-Peucker simplification (0.7 cell), one Chaikin smoothing pass |
| Flood trajectory polygon | flooded cells at the selected horizon |
| Evacuation zone polygon | flooded cells at the selected horizon and at the next forecast step, widened by 3 cells (about 0.6 km) |

The shape comes from the flood (terrain, discharge, connectivity), not from a fixed radius. Two straight edges
appear where the 16 km reach is cut, and the lateral edge is the limit of the terrain grid (15 km from the river).

### 3.5 Population and phones

| Parameter | Value |
|---|---|
| Population source | WorldPop 2020, 100 m grid, "stats" API (task create then poll), summed inside the evacuation zone |
| Fallback | If WorldPop is slow or unreachable: 900 people per km2 (Bihar rural average) x zone area, clearly labelled |
| Phones per person | 0.6 (assumption; rural Bihar mobile teledensity is roughly 0.5 to 0.7) |
| Icons | one phone icon per group of phones (up to 400 icons); placed near mapped villages inside the zone |
| Broadcast | Simulated: icons turn green over 3.2 s; no call or message is sent |

Population is a real, live estimate. The phone count is derived from it with an assumed phones-per-person rate. The
exact position of each phone is not known; icons only show where phones are likely to be.

---

## 4. Results (exercise towns, replay clock)

These first-version results (12 km circle, seeded demo devices) are kept for reference. The current version uses the
river-reach polygons and WorldPop population described above; open a town on the map for the current numbers.

| Town | Water reaches town | NOW | +3 h | +6 h | +12 h | +24 h |
|---|---|---|---|---|---|---|
| Barariha | ~1 h | 13.6 km2 / 80 dev | 41.2 / 164 | 101.5 / 502 | 210.7 / 948 | 349.0 / 1,283 |
| Birwat Kundaulia | ~3 h | 0 / 0 | 4.7 / 51 | 42.3 / 189 | 184.7 / 868 | 330.2 / 1,209 |
| Harpur | ~5 h | 0 / 0 | 3.4 / 7 | 25.5 / 201 | 138.1 / 767 | 315.8 / 1,150 |
| Manjhariya | ~5 h | 0 / 0 | 0 / 0 | 5.6 / 49 | 57.2 / 284 | 271.3 / 1,067 |
| Salehpur | ~9 h | 0 / 0 | 0 / 0 | 0 / 0 | 15.5 / 64 | 172.1 / 693 |

Arrival times are model-derived (connected flood water within 1 km of the village point).

---

## 5. How the alert would work in a real deployment

- The polygon is sent as **one geo-targeted message** (cell broadcast through the national CAP platform, plus
  app push), so every phone in the polygon is alerted at once. India's Sachet/CAP system supports
  geo-targeted cell broadcast. Individual calls are used only for named contacts (sarpanch, relief teams).
- The existing flow (operator review, Approve, Hindi AI call to one contact) stays as the human-in-the-loop gate.
  The polygon tells the operator **how many people** the approval would reach.

---

## 6. Limits to state honestly

- Replay of one event, not a live forecast. Calibrated on one flood (three radar maps), not validated across seasons.
- No flood depth. The model predicts whether water reaches a place, not how deep.
- No embankments or canals in the terrain model; a hydraulic model (HEC-RAS, LISFLOOD-FP) would be the upgrade.
- About 200 m cells: village scale, not street scale.
- GloFAS is a global model, not a gauge. There is no public real-time gauge feed for the Gandak.
- Phone positions are illustrative and the phone count is an estimate (population x 0.6). Live Open-Meteo data was rate limited during development, so the page can fall back to the replay.

---

## 7. Likely questions and answers

| Question | Answer |
|---|---|
| Is this a prediction or a replay? | A replay of the real September 2026 flood, to demonstrate the method on real data. |
| Why a polygon instead of a circle? | The flood does not spread in a circle. The polygon follows the connected flooded cells, so it follows the river and low ground. |
| How do you know water reaches the town? | A cell floods only if its probability passes p* and it connects to the river through other flooded cells. |
| Where do the phone numbers come from? | WorldPop population inside the evacuation polygon, times an assumed 0.6 phones per person. Real device locations are private and are not available; an operator cell broadcast would reach them directly. |
| Why not call every device? | Mass calling does not scale and is slow. A geo-targeted cell broadcast reaches the whole polygon at once. |
| What are the two polygons? | Red: where the flood water goes. Violet: the evacuation zone, the flood now and at the next step plus a margin, which should be empty. |
| What would improve accuracy? | Gauge data, a hydraulic model with embankments, higher-resolution DEM, and validation on more floods. |
