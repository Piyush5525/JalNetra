# AWS services used by JalNetra

Created with the AWS CLI next to the CDK stack (ap-south-1 unless noted). Each one does real work in the product.

| Service | Resource | What it does |
|---|---|---|
| Lambda | `jalnetra-api` | API: exercise sessions, approvals, `/ai/*` helpers, cached weather proxy |
| Lambda | `jalnetra-scheduled-jobs` (`dist/monitor.handler`) | India river monitor: GloFAS forecast for 681 points -> snapshot in S3 |
| API Gateway (HTTP API) | `u51iah4nqf` | Public API; default route throttle 30 rps / burst 60 |
| RDS PostgreSQL, VPC, NAT | CDK stack | Sessions, call ledger, incidents |
| Secrets Manager | `jalnetra/prototype/*` | API keys, DB credentials, telephony secret |
| SQS | `jalnetra-alerts` (+ DLQ) | Alert queue |
| EventBridge Scheduler | `jalnetra-reverify-3h` (ENABLED), `jalnetra-radar-15m` (disabled) | Runs the river monitor every 3 hours |
| S3 + CloudFront | `jalnetra-web-prod-<account>` / `E15UTKVM0WN4DS` | Website, `india/snapshot.json`, `audio/*.mp3` |
| WAF (us-east-1, CLOUDFRONT scope) | `jalnetra-web` | AWS managed common rules, IP reputation, 600 requests / 5 min per IP on the website |
| Amazon Polly | Kajal (neural) / Aditi, `hi-IN` | Hindi spoken advisory, cached as MP3 in S3 |
| Amazon Bedrock | `apac.amazon.nova-lite-v1:0` | Fact-bound advisory drafts (Hindi + English), human-reviewed |
| Amazon Location Service | route calculator `jalnetra-routes` (Esri) | Real walking routes and step list |
| Amazon Rekognition | `DetectLabels` | First-screen check of a citizen's flood photo |
| Amazon SNS | topic `jalnetra-alerts` | Approval notices and "river newly rising" notices (add subscribers to receive them) |
| AWS Step Functions | `jalnetra-alert-followup` | After an approval: announce, wait 90 s, escalate if the call did not dispatch. Never retries a call |
| CloudWatch | dashboard `JalNetra-operations`, alarms, logs | Operations view |
| IAM | inline policies `jalnetra-extras` (API role), `jalnetra-monitor` (job role), role `jalnetra-sfn-followup` | Least-privilege access for the above |

Not enabled: Amazon Translate (account needs a subscription), Amazon Connect (not used; voice calls go through OmniDimension).

Teardown of the extras: delete the schedule, state machine, SNS topic, route calculator, WAF ACL (disassociate from CloudFront first),
the two inline policies and `jalnetra-sfn-followup`, then remove the `JALNETRA_*` variables from the API Lambda.
