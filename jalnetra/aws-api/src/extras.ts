// AWS-powered helpers for the website: speech (Polly), AI-drafted advisories (Bedrock), walking routes (Amazon Location Service),
// photo checks (Rekognition) and approval notifications (SNS + Step Functions). All routes are read-only or stateless, size-limited
// and rate-limited per source address. None of them can place a call or touch incidents.
import { createHash } from "node:crypto";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { LocationClient, CalculateRouteCommand } from "@aws-sdk/client-location";
import { RekognitionClient, DetectLabelsCommand } from "@aws-sdk/client-rekognition";
import { S3Client, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";

export type ExtraReply = { status: number; body: unknown; headers?: Record<string, string> };
type Json = Record<string, unknown>;

const REGION = process.env.AWS_REGION ?? "ap-south-1";
const BUCKET = process.env.JALNETRA_WEB_BUCKET ?? "jalnetra-web-prod-467021296348";
const PUBLIC_BASE = (process.env.JALNETRA_PUBLIC_BASE_URL ?? "https://d1oi8xa605dsj6.cloudfront.net").replace(/\/+$/, "");
const CALCULATOR = process.env.JALNETRA_ROUTE_CALCULATOR ?? "jalnetra-routes";
const MODEL_ID = process.env.JALNETRA_BEDROCK_MODEL ?? "apac.amazon.nova-lite-v1:0";
const TOPIC_ARN = process.env.JALNETRA_ALERT_TOPIC_ARN ?? "";
const WORKFLOW_ARN = process.env.JALNETRA_WORKFLOW_ARN ?? "";

const polly = new PollyClient({ region: REGION });
const bedrock = new BedrockRuntimeClient({ region: REGION });
const location = new LocationClient({ region: REGION });
const rekognition = new RekognitionClient({ region: REGION });
const s3 = new S3Client({ region: REGION });
const sns = new SNSClient({ region: REGION });
const sfn = new SFNClient({ region: REGION });

const reply = (status: number, body: unknown): ExtraReply => ({ status, body });
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max) : "");

// ---- tiny in-memory rate limiter (per warm container; the API Gateway stage throttle is the hard limit) ----
const hits = new Map<string, { n: number; reset: number }>();
function limited(ip: string, bucket: string, perMinute: number): boolean {
  const key = `${bucket}:${ip}`, now = Date.now();
  const cur = hits.get(key);
  if (!cur || now > cur.reset) { hits.set(key, { n: 1, reset: now + 60_000 }); if (hits.size > 5000) hits.clear(); return false; }
  cur.n += 1;
  return cur.n > perMinute;
}

// ---- Polly: Hindi speech, cached in S3 and served through CloudFront ----
async function tts(body: Json): Promise<ExtraReply> {
  const text = str(body.text, 600);
  if (text.length < 2) return reply(400, { error: "text is required" });
  const voice = body.voice === "Aditi" ? "Aditi" : "Kajal";
  const engine = voice === "Kajal" ? "neural" : "standard";
  const key = `audio/${createHash("sha256").update(`${voice}|${text}`).digest("hex").slice(0, 40)}.mp3`;
  const url = `${PUBLIC_BASE}/${key}`;
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return reply(200, { url, voice, cached: true, characters: text.length });
  } catch { /* not cached yet */ }
  const speech = await polly.send(new SynthesizeSpeechCommand({ Text: text, VoiceId: voice, Engine: engine, LanguageCode: "hi-IN", OutputFormat: "mp3" }));
  const bytes = speech.AudioStream ? await speech.AudioStream.transformToByteArray() : null;
  if (!bytes || !bytes.length) return reply(502, { error: "Speech synthesis returned no audio" });
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: bytes, ContentType: "audio/mpeg", CacheControl: "public, max-age=31536000, immutable" }));
  return reply(200, { url, voice, cached: false, characters: text.length, bytes: bytes.length });
}

// ---- Bedrock: a short, fact-bound advisory draft in Hindi and English (always human-reviewed before use) ----
async function advisory(body: Json): Promise<ExtraReply> {
  const f = { village: str(body.village, 60), district: str(body.district, 60), risk: str(body.risk, 20), impact: str(body.impact, 60), shelter: str(body.shelter, 100), km: str(body.km, 10) };
  const exercise = body.exercise === true;
  if (!f.village) return reply(400, { error: "village is required" });
  const facts = `village: ${f.village}${f.district ? `, ${f.district}` : ""}\nrisk level: ${f.risk || "unknown"}\nwater expected: ${f.impact || "not stated"}\nsafe place: ${f.shelter || "nearest high ground"}${f.km ? `\ndistance to safe place: ${f.km} km` : ""}`;
  const prompt = `You write short emergency advisories that a local official reads out to villagers.\nRules: use ONLY the facts below; never add numbers, places, times or causes that are not given; calm, direct, one idea per sentence; at most 45 words per language.${exercise ? "\nThis is a rehearsal: begin the Hindi with \"अभ्यास:\" and the English with \"EXERCISE:\"." : ""}\nReturn ONLY JSON: {"hi":"<Hindi text>","en":"<English text>"}\n\nFacts:\n${facts}`;
  let drafted: { hi?: string; en?: string } | null = null;
  try {
    const out = await bedrock.send(new ConverseCommand({ modelId: MODEL_ID, messages: [{ role: "user", content: [{ text: prompt }] }], inferenceConfig: { maxTokens: 400, temperature: 0.2 } }));
    const raw = out.output?.message?.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "";
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) drafted = JSON.parse(m[0]) as { hi?: string; en?: string };
  } catch (error) {
    console.error("Bedrock advisory failed", error);
  }
  const hi = str(drafted?.hi, 500), en = str(drafted?.en, 500);
  if (hi && en) return reply(200, { hi, en, model: MODEL_ID, drafted: true });
  const fallbackEn = `${exercise ? "EXERCISE: " : ""}${f.village}: ${f.risk || "flood"} risk${f.impact ? `, water expected ${f.impact}` : ""}. Move to ${f.shelter || "the nearest high ground"}${f.km ? ` (${f.km} km)` : ""} now.`;
  return reply(200, { hi: "", en: fallbackEn, model: null, drafted: false });
}

// ---- Amazon Location Service: a real walking route with distances per leg ----
const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
function bearing(a: [number, number], b: [number, number]) {
  const r = (d: number) => (d * Math.PI) / 180, y = Math.sin(r(b[0] - a[0])) * Math.cos(r(b[1]));
  const x = Math.cos(r(a[1])) * Math.sin(r(b[1])) - Math.sin(r(a[1])) * Math.cos(r(b[1])) * Math.cos(r(b[0] - a[0]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
function parsePoint(v: string | undefined): [number, number] | null {
  const m = (v ?? "").match(/^(-?\d{1,3}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]), lng = Number(m[2]);
  return lat >= 5 && lat <= 38 && lng >= 67 && lng <= 98 ? [lat, lng] : null; // South Asia only
}
async function walkingRoute(query: Record<string, string | undefined>): Promise<ExtraReply> {
  const from = parsePoint(query.from), to = parsePoint(query.to);
  if (!from || !to) return reply(400, { error: "from and to must be 'lat,lng' inside South Asia" });
  const out = await location.send(new CalculateRouteCommand({ CalculatorName: CALCULATOR, DeparturePosition: [from[1], from[0]], DestinationPosition: [to[1], to[0]], TravelMode: "Walking", IncludeLegGeometry: true, DistanceUnit: "Kilometers" }));
  const leg = out.Legs?.[0];
  if (!leg || !out.Summary) return reply(404, { error: "No walking route found" });
  const steps = (leg.Steps ?? []).map((s) => {
    const a = (s.StartPosition ?? [0, 0]) as [number, number], b = (s.EndPosition ?? [0, 0]) as [number, number];
    const meters = Math.round((s.Distance ?? 0) * 1000);
    return { meters, minutes: Math.max(1, Math.round((s.DurationSeconds ?? 0) / 60)), direction: COMPASS[Math.round(bearing(a, b) / 45) % 8], text: `Walk ${COMPASS[Math.round(bearing(a, b) / 45) % 8]} for ${meters >= 1000 ? (meters / 1000).toFixed(1) + " km" : meters + " m"}` };
  }).filter((s) => s.meters > 0);
  return reply(200, { km: Number((out.Summary.Distance ?? 0).toFixed(2)), minutes: Math.round((out.Summary.DurationSeconds ?? 0) / 60), path: leg.Geometry?.LineString ?? [], steps, source: "Amazon Location Service (Esri)" });
}

// ---- Rekognition: does a citizen's photo show flood water? ----
const FLOOD_LABELS = new Set(["Flood", "Flooding", "Flash Flood", "Inundation"]);
const WATER_LABELS = new Set(["Water", "River", "Lake", "Sea", "Waterfront", "Pond", "Puddle", "Stream"]);
async function checkPhoto(body: Json): Promise<ExtraReply> {
  const raw = typeof body.imageBase64 === "string" ? body.imageBase64.replace(/^data:[^;]+;base64,/, "") : "";
  if (!raw || raw.length > 4_800_000) return reply(400, { error: "imageBase64 is required (JPEG or PNG, up to about 3.5 MB)" });
  const bytes = Buffer.from(raw, "base64");
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8, png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (!jpeg && !png) return reply(400, { error: "Only JPEG or PNG photos are accepted" });
  const out = await rekognition.send(new DetectLabelsCommand({ Image: { Bytes: bytes }, MaxLabels: 30, MinConfidence: 55 }));
  const labels = (out.Labels ?? []).map((l) => ({ name: l.Name ?? "", confidence: Math.round(l.Confidence ?? 0) })).filter((l) => l.name);
  const flood = Math.max(0, ...labels.filter((l) => FLOOD_LABELS.has(l.name)).map((l) => l.confidence));
  const water = Math.max(0, ...labels.filter((l) => WATER_LABELS.has(l.name)).map((l) => l.confidence));
  const verdict = flood >= 70 ? "likely" : flood >= 50 || water >= 80 ? "possible" : "unclear";
  return reply(200, { verdict, floodConfidence: flood, waterConfidence: water, labels: labels.slice(0, 12), note: "An automatic check, not proof. A person should confirm before acting." });
}

export async function routeExtras(method: string, path: string, query: Record<string, string | undefined>, body: Json | null, ip: string): Promise<ExtraReply | null> {
  if (!path.startsWith("/ai/")) return null;
  try {
    if (path === "/ai/tts" && method === "POST") return limited(ip, "tts", 20) ? reply(429, { error: "Too many requests" }) : await tts(body ?? {});
    if (path === "/ai/advisory" && method === "POST") return limited(ip, "adv", 10) ? reply(429, { error: "Too many requests" }) : await advisory(body ?? {});
    if (path === "/ai/route" && method === "GET") return limited(ip, "route", 20) ? reply(429, { error: "Too many requests" }) : await walkingRoute(query);
    if (path === "/ai/photo" && method === "POST") return limited(ip, "photo", 6) ? reply(429, { error: "Too many requests" }) : await checkPhoto(body ?? {});
    return reply(404, { error: `No route for ${method} ${path}` });
  } catch (error) {
    console.error("AI helper failed", path, error);
    return reply(502, { error: "The AWS service is unavailable right now. Try again shortly." });
  }
}

/** After an exercise approval: tell the alerts topic and start the follow-up workflow. Never throws; never blocks the approval. */
export async function notifyApproval(reply: { status: number; body: unknown }): Promise<void> {
  try {
    const b = reply.body as { replayed?: boolean; alert?: { id?: string; title?: string; callStatus?: string; prediction?: { villageName?: string; horizonHours?: number | null } } } | null;
    if (reply.status !== 200 || !b?.alert || b.replayed) return;
    const a = b.alert, summary = { alertId: a.id ?? "", village: a.prediction?.villageName ?? "", horizonHours: a.prediction?.horizonHours ?? null, callStatus: a.callStatus ?? "unknown", at: new Date().toISOString(), exercise: true };
    const tasks: Promise<unknown>[] = [];
    if (TOPIC_ARN) tasks.push(sns.send(new PublishCommand({ TopicArn: TOPIC_ARN, Subject: `JalNetra exercise alert approved: ${summary.village}`.slice(0, 99), Message: `EXERCISE. Alert for ${summary.village} was approved (+${summary.horizonHours ?? "?"} h). Demo call status: ${summary.callStatus}. This is a rehearsal, not a real flood warning.` })));
    if (WORKFLOW_ARN) tasks.push(sfn.send(new StartExecutionCommand({ stateMachineArn: WORKFLOW_ARN, input: JSON.stringify(summary) })));
    await Promise.race([Promise.allSettled(tasks), new Promise((r) => setTimeout(r, 3000))]);
  } catch (error) {
    console.error("approval notification failed", error);
  }
}
