# JalNetra incident API

One API for every part of JalNetra. Each part sends what it detects; the operator dashboard shows everything in one place and moves it through the lifecycle.

Base URL (prototype, Supabase Edge Function; final version moves to AWS API Gateway + Lambda with the same contract):
`https://oceaylrebzflgyxfjqfb.supabase.co/functions/v1/jalnetra-api`

Every request needs your team key in the header `x-jalnetra-key` (keys are in TEAM_KEYS.txt, shared privately).

## Send an incident
`POST /incidents`

```json
{
  "incident_type": "waterlogging",        // river_flood | waterlogging | pothole | leak
  "severity": "medium",                   // low | medium | high
  "confidence": 0.82,                     // 0..1, optional (default 0.5)
  "lat": 25.6093, "lng": 85.1376,
  "source": "dashcam",                    // satellite | forecast | cctv | dashcam | app | whatsapp | sms | call | sensor
  "observed_at": "2026-10-06T10:32:00Z",  // optional, defaults to now
  "language": "hi",                       // optional
  "title": "Knee-deep water at Boring Road junction",
  "evidence_url": "https://.../frame123.jpg",
  "details": { "depth_level": "medium", "rain_confirmed": true }   // anything part-specific
}
```

Response `201` with `{ "merged": false, "incident": {...} }`.
If an open incident of the same type already exists within 150 m (3 km for river floods) in the last 6 hours, the report is merged into it instead: `200` with `merged: true`, its `reports` count goes up and confidence rises.

Errors come back as `{ "error": "...", "details": [...] }` with status 400 (bad body), 401 (bad key), 403, 404 or 409.

curl:
```
curl -X POST "$API/incidents" -H "x-jalnetra-key: $KEY" -H "content-type: application/json" \
  -d '{"incident_type":"pothole","severity":"low","lat":25.61,"lng":85.14,"source":"app","title":"Pothole near bus stand"}'
```

Python:
```python
import requests
r = requests.post(f"{API}/incidents", headers={"x-jalnetra-key": KEY}, json={
    "incident_type": "leak", "severity": "high", "confidence": 0.9, "lat": 25.6, "lng": 85.1,
    "source": "sensor", "title": "Zone 3 losing 6% of inflow", "details": {"loss_pct": 6.1, "litres_per_day": 1800}})
print(r.status_code, r.json())
```

## Read incidents
- `GET /incidents?type=leak,pothole&status=detected,approved&bbox=84,25,86,27&limit=200`
- `GET /incidents/{id}` returns the incident plus its full history (`events`).
Each incident carries `overdue: true` when its SLA has passed and it is still open.

## Lifecycle (operator key only)
`PATCH /incidents/{id}` with `{ "status": "approved", "note": "optional" }`

| From | Allowed next |
| --- | --- |
| detected | approved, rejected |
| approved | ticketed, rejected |
| ticketed | fixed_claimed, escalated |
| fixed_claimed | verified, reopened |
| reopened | ticketed, escalated |
| escalated | ticketed, fixed_claimed |

SLA starts when the incident is created: 6 h (high), 24 h (medium), 72 h (low). Reopening restarts it.

## Health
`GET /health` (no key needed)

## Evidence (any key)
`POST /incidents/{id}/evidence` with `{ "note": "Re-check with Sentinel-1 ...", "data": {...}, "evidence_url": "..." }`
Adds proof to the incident's history without changing its status. The flood part uses this to attach each newer radar pass (`pipeline/reverify.py`).

## Contacts (operator to add, anyone to read)
- `GET /contacts?lat=26.12&lng=84.93&km=25` returns contacts sorted by distance.
- `POST /contacts` with `{ "name": "...", "role": "sarpanch|asha|ngo|official|volunteer", "phone": "+91XXXXXXXXXX", "place_name": "...", "district": "...", "lat": 26.1, "lng": 84.9 }`

## Warnings (operator)
- `GET /telephony` returns `{ "call": "omnidimension" | "twilio" | "not_configured", "demo_phone": "+91******0402" }`.
- `POST /incidents/{id}/alerts` with
  `{ "contact_ids": ["..."], "message": "Hindi text", "channel": "call" | "sms", "demo": true, "context": { "place", "title", "source", "observed", "safe_place" } }`
  - Calls go through the OmniDimension agent "JalNetra Flood Alert" (Hindi). It speaks `message` first, then answers questions using `context`. Config rows in `jn_config`: `omnidim_key`, `omnidim_agent`, `omnidim_from`.
  - `demo: true` also calls `jn_config.alert_phone`, so you can demo with zero contacts.
  - SMS (and calls when OmniDimension is not set) fall back to Twilio (`twilio_sid`, `twilio_token`, `twilio_from`). With neither, alerts are logged as `not_configured`.
- `GET /incidents/{id}/alerts` lists what was sent and what failed.
