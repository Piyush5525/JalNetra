<!--
HOW TO USE THIS IN THE BUILDER CENTER EDITOR
Toolbar available: Paragraph/headings, Bold, Italic, Inline code, Code block, Link, Bullets, Numbers, Image, Divider, Table.
- Paste each section in order. Headings: pick "Heading 2" from the Paragraph dropdown.
- Every line that says [IMAGE: file] is a spot to click the image icon and upload that file from presentation/blog/
- Cover image: presentation/builder-cover-1.png
- Description: A glacier broke in Nepal. The first alarm came 2 hours 43 minutes later. We built the missing warning on AWS, with a person in the loop and honest numbers.
- Tags: aws, disaster-management, serverless, amazon-bedrock, amazon-polly
-->

# JalNetra: Because 2 Hours 43 Minutes Is Too Late

On 26 August 2026 a glacier collapsed above Langtang in Nepal. Seven minutes later the flood had already travelled 20 km. It ran **226 km** to the Indian border.

The water was not the only failure. **The silence was.** The first alarm on the gauge network came **2 hours 43 minutes** after the collapse, and by then the gauges nearest the source had gone dark while still reading normal.

We built **JalNetra** (जल water + नेत्र eye: the eye on the water) to close that gap. It watches every river, finds the villages the water will reach, and lets a **person** approve a Hindi voice warning to the village head. It runs entirely on AWS.

[IMAGE: 01-home.jpg]

*Try it: https://d1oi8xa605dsj6.cloudfront.net*

---

## The 2 hours 43 minutes, minute by minute

| Time | What happened |
|---|---|
| 08:37 | Glacier collapse at Langtang Lirung |
| +7 min | The flood has already travelled about 20 km |
| Next | The gauges near the source go dark, still reading normal. No alarm is raised |
| 11:20 | First alarm on the gauge network, **2 h 43 min** after the collapse |
| Evening | Water crosses into India at Valmikinagar |

Villages downstream had hours they were never told about. That is the whole problem: not the size of the flood, but the **communication gap**.

[IMAGE: 04-glacier-story-gauges.jpg]

*The glacier story page replays the event with the real timeline and satellite imagery.*

---

## What JalNetra does

- **Watch.** 681 river points across India, checked every 3 hours against each river's own record
- **Predict.** Which of 291 villages along the Gandak the water reaches, and when: now, +3, +6, +12 and +24 hours
- **Decide.** A person reviews the map and the advisory, then approves or rejects. Nothing is automatic
- **Warn.** One Hindi voice call, a spoken advisory, a 3D evacuation route and an AR arrow to the safe place

[IMAGE: 02-live-india-map.jpg]

*The live map: every river point in India, scored against its own monsoon.*

Demo video (3 minutes): *paste the YouTube link on its own line here and the editor will show it as a link card*

---

## How it runs on AWS

Every stage uses a managed service, and nothing runs on a server we have to patch.

[IMAGE: 06-aws-dataflow-3d.jpg]

*The data flow as a 3D scene: letters travelling between mailboxes.*

| Service | Job in JalNetra |
|---|---|
| **EventBridge Scheduler + Lambda** | Every 3 hours the monitor reads river forecasts and writes one snapshot |
| **S3 + CloudFront + WAF** | The website, the snapshot and cached Hindi audio, behind managed rules and rate limits |
| **API Gateway + Lambda** | Throttled public API, approvals and helpers |
| **RDS PostgreSQL + Secrets Manager** | Call ledger, per-alert and daily limits, the one allowed destination number |
| **Amazon Bedrock (Nova Lite)** | Fact-bound Hindi and English advisory drafts, always reviewed by a person |
| **Amazon Polly (Kajal)** | The spoken Hindi advisory, cached in S3 |
| **Amazon Location Service** | Real walking routes to the safe place |
| **Amazon Rekognition** | First-screen check of a citizen's flood photo |
| **Step Functions + SNS + SQS** | After approval: wait, check, escalate. A call is never retried |
| **CloudWatch + CDK** | Dashboard, alarms and infrastructure as code |

### From a river reading to a ringing phone

1. **Monitor.** EventBridge wakes a Lambda that scores every river point against its own 2025 monsoon, with a minimum flow so a trickle never raises a flag. One snapshot goes to S3 and CloudFront serves it
2. **Approve.** The operator opens an alert and sees the villages, the timing and the advisory draft. Opening an alert never calls anyone. Only **Approve** does
3. **Voice and route.** Polly speaks the Hindi advisory, Location Service finds the walking route, and the village head gets a link that opens the route in 3D, with an AR arrow on the phone

[IMAGE: 05-simulated-flood-route.jpg]

*A simulated flood and its evacuation route. There is no flood where we tested, so the water here is a made-up one.*

---

## How good is the model? Honest numbers

The village score is a small logistic model on four things: the 72-hour peak river flow, the village's height above the river, its height relative to its surroundings, and its distance from the river. A village is flagged when the probability reaches **0.25**.

```
flag a village  when  P(flooded) >= 0.25
inputs: ln(Q72max / 4000), height above river, height vs surroundings, distance
```

We tested it against real Sentinel-1 radar flood maps from the 2026 event, leaving each radar date out when training:

| Result | Value |
|---|---|
| Flooded villages caught | **56% and 66%** (two radar dates) |
| Ranking skill (AUC) | **0.72 to 0.75** (0.5 is a coin flip) |
| Flagged villages that were really flooded (29 Sept) | 36%, with 70 false alarms |

This is an early-warning **screen**, not a guarantee. Radar only sees open water, so flooding under trees and from local rain is missed. We would rather say that plainly than oversell it.

---

## Safety by design

A warning system that can phone people has to be hard to misuse.

- No call is ever automatic. A person approves every one
- A call can reach **only** the configured demo phone. No route accepts a phone number
- One attempt per alert, a cooldown, 3 calls per session and a daily cap, all enforced on the server
- "Dispatched" is never shown as "answered". Failed or unknown outcomes stay locked
- Exercise data is labelled **EXERCISE** everywhere and kept apart from real incidents

---

## What surprised us

1. **The free weather API rate-limited our own site.** Hundreds of points at once meant HTTP 429s. A cached proxy on Lambda plus one shared snapshot in S3 fixed it
2. **AWS WAF cannot attach to an HTTP API.** The website sits behind WAF on CloudFront. The API relies on stage throttling and server-side limits instead
3. **Bedrock in Mumbai needed a regional inference profile.** The `apac.` Nova Lite profile worked where the plain model id did not
4. **Amazon Translate needed a subscription we did not have,** so Hindi comes from Bedrock and Polly

---

## What is next

- A second app, **Oasis Builder** (Unity, Android AR), works on prevention: place a tree or a green patch and see how much rain the land can hold
- Subscribe village heads and district officers to alerts through SNS
- Replace the single demo phone with a verified contact list per district

**Try it:** https://d1oi8xa605dsj6.cloudfront.net
**Code:** add the GitHub link for the `aws-disaster-management` branch here

*Launch post on X: paste the link on its own line here.*

---

*JalNetra: जल (water) + नेत्र (eye). The eye on the water.*
