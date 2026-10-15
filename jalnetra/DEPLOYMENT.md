# Vercel deployment

The site is a Vite build and can be deployed from the `jalnetra-flood-map` directory.

## 1. Deploy the site

```sh
npm install
npm run build
```

Import the project into Vercel with:

- **Build command:** `npm run build`
- **Output directory:** `dist`
- **Root directory:** `jalnetra-flood-map` (when importing the parent folder)

The radar endpoint is available at `/api/cron/radar-alerts`, but it is not declared as a
Vercel Cron job because Vercel Hobby projects reject schedules more frequent than once per
day. Run the 15-minute radar schedule from the existing Supabase scheduler (or move the
project to a Vercel plan that supports minute-level cron schedules).

## 2. Configure environment variables

Set these in the Vercel project settings for Production:

| Variable | Purpose |
| --- | --- |
| `VITE_JALNETRA_API` | Shared JalNetra API URL |
| `VITE_JALNETRA_KEY` | Optional demo/operator key. Prefer leaving this unset for a public site. |
| `JALNETRA_API` | Shared API URL used by the server-side cron worker |
| `JALNETRA_KEY` | Operator key used only by the cron worker |
| `CRON_SECRET` | Random secret; required by the cron endpoint |
| `RADAR_FEED_URL` | HTTPS JSON feed containing the latest radar detections |
| `JALNETRA_ALERT_CONTACT_IDS` | Optional comma-separated contact IDs for the configured alert workflow. |

The browser never receives `JALNETRA_KEY` or `CRON_SECRET`. Do not use an operator key as
`VITE_JALNETRA_KEY` on a public deployment.

## 3. Radar feed format

`RADAR_FEED_URL` must return an object with a `detections` array. Each item is posted to
`POST /incidents`; a newly created incident is then sent to
`POST /incidents/{id}/alerts` as a Hindi voice call.

```json
{
  "detections": [
    {
      "incident_type": "river_flood",
      "severity": "high",
      "confidence": 0.86,
      "lat": 26.12,
      "lng": 84.93,
      "observed_at": "2026-10-07T00:00:00Z",
      "title": "Radar flood near Dumariaghat",
      "evidence_url": "https://example.org/sentinel-1/o4.tif",
      "details": {
        "reach": "Dumariaghat",
        "villages": ["Dumariya"]
      }
    }
  ]
}
```

The shared API merges detections that are already open and nearby. The cron worker only
places calls for incidents returned as `merged: false`, so repeated feed polls do not call
the same open incident every 15 minutes.

## 4. Verify after deployment

```sh
curl https://YOUR_DOMAIN/health
curl -H "Authorization: Bearer $CRON_SECRET" https://YOUR_DOMAIN/api/cron/radar-alerts
```

The second request should return `{ "processed": ... }`. The external scheduler should invoke
the same endpoint every 15 minutes after the deployment is live.
