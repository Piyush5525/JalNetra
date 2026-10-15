// Scheduled river monitor (EventBridge Scheduler -> Lambda). Every run it reads the GloFAS forecast for every river point
// (free Open-Meteo flood API, 8 batched requests), classifies each point against its own 2025 monsoon, and writes a snapshot to S3.
// The website reads that snapshot first (served by CloudFront), so visitors never wait on, or rate-limit, the weather service.
// If a point newly reaches High or above and is rising, the alerts topic is notified. No calls are placed from here.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { S3Client, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";

type Point = { id: number; river: string; near: string; state: string; glat: number; glng: number; p50: number; p90: number; max: number };
type Status = "NORMAL" | "RISING" | "WARNING" | "DANGER";
type Trend = "rising" | "falling" | "steady";
type Row = [number, Status, number, number, number, number | null, Trend];

const REGION = process.env.AWS_REGION ?? "ap-south-1";
const BUCKET = process.env.JALNETRA_WEB_BUCKET ?? "jalnetra-web-prod-467021296348";
const TOPIC_ARN = process.env.JALNETRA_ALERT_TOPIC_ARN ?? "";
const KEY = "india/snapshot.json";
const MIN_FLOW = 50; // m3/s: a trickle is not flagged (a single monsoon of history makes tiny flows look extreme)
const s3 = new S3Client({ region: REGION });
const sns = new SNSClient({ region: REGION });

function loadPoints(): Point[] {
  // dist/monitor.js -> ../data, and the test build (.test-build/src/monitor.js) -> ../../data
  for (const rel of ["../data/rivers.json", "../../data/rivers.json"]) {
    try { return (JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8")) as { points: Point[] }).points; } catch { /* try the next location */ }
  }
  throw new Error("rivers.json not found next to the function code");
}
const points: Point[] = loadPoints();

/** Same rules as the website's River Watch (src/engine/india.ts). */
export function classify(p: Point, days: string[], q: (number | null)[], todayIso: string): Row {
  const series = q.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : NaN));
  let today = days.indexOf(todayIso);
  if (today < 0) today = Math.max(0, days.findIndex((d) => d > todayIso) - 1);
  const now = series[today];
  const fut = series.slice(today, today + 8).filter(Number.isFinite);
  const peak = fut.length ? Math.max(...fut) : now;
  const peakDay = series.slice(today, today + 8).indexOf(peak);
  let status: Status = peak >= p.max ? "DANGER" : peak >= p.p90 ? "WARNING" : peak >= 1.25 * now && peak >= p.p50 ? "RISING" : "NORMAL";
  const thr = status === "DANGER" ? p.max : status === "WARNING" ? p.p90 : null;
  let crossDay: number | null = null;
  if (thr !== null) for (let k = 0; k < 8; k++) if (series[today + k] >= thr) { crossDay = k; break; }
  const later = series[today + 3];
  const trend: Trend = peakDay > 0 && peak > now * 1.05 ? "rising" : Number.isFinite(later) && later < now * 0.95 ? "falling" : "steady";
  if (status !== "NORMAL" && Math.max(peak, p.max) < MIN_FLOW) status = "NORMAL";
  return [p.id, status, Math.round(now), Math.round(peak), Math.max(0, peakDay), crossDay, trend];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchBatch(batch: Point[]): Promise<unknown[]> {
  const url = `https://flood-api.open-meteo.com/v1/flood?latitude=${batch.map((p) => p.glat).join(",")}&longitude=${batch.map((p) => p.glng).join(",")}&daily=river_discharge&past_days=3&forecast_days=8`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 429) throw Object.assign(new Error("Open-Meteo rate limit (429)"), { rateLimited: true });
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const body = await res.json();
    return Array.isArray(body) ? body : [body];
  } finally { clearTimeout(timer); }
}

export const handler = async () => {
  const todayIso = new Date().toISOString().slice(0, 10);
  const rows: Row[] = [];
  let failed = 0;
  for (let i = 0; i < points.length; i += 90) {
    const batch = points.slice(i, i + 90);
    try {
      // The free tier counts every location, so batches are paced (~450 locations/min), and a 429 is waited out once.
      if (i > 0) await sleep(13_000);
      let raw: unknown[];
      try { raw = await fetchBatch(batch); } catch (error) {
        if (!(error as { rateLimited?: boolean }).rateLimited) throw error;
        await sleep(45_000);
        raw = await fetchBatch(batch);
      }
      const data = raw as { daily?: { time?: string[]; river_discharge?: (number | null)[] } }[];
      batch.forEach((p, k) => {
        const d = data[k]?.daily;
        if (!d?.time || !d.river_discharge || d.time.length !== d.river_discharge.length || d.time.indexOf(todayIso) < 0) { failed++; return; }
        rows.push(classify(p, d.time, d.river_discharge, todayIso));
      });
    } catch (error) {
      console.error("batch failed", i, error);
      failed += batch.length;
    }
  }
  if (rows.length < points.length * 0.8) throw new Error(`Only ${rows.length}/${points.length} points had valid data; keeping the previous snapshot`);

  const by: Record<Status, number> = { NORMAL: 0, RISING: 0, WARNING: 0, DANGER: 0 };
  rows.forEach((r) => by[r[1]]++);
  const byId = new Map(points.map((p) => [p.id, p]));
  const flagged = rows.filter((r) => r[1] !== "NORMAL").map((r) => ({ river: byId.get(r[0])!.river, near: byId.get(r[0])!.near, status: r[1], trend: r[6] }));
  const alertRivers = [...new Set(rows.filter((r) => (r[1] === "WARNING" || r[1] === "DANGER") && r[6] === "rising").map((r) => byId.get(r[0])!.river))];
  const rising = [...new Set(rows.filter((r) => r[1] === "RISING").map((r) => byId.get(r[0])!.river))];
  const headline = alertRivers.length ? `${alertRivers.length} river${alertRivers.length === 1 ? "" : "s"} rising to flood levels`
    : rising.length ? `${rising.length} river${rising.length === 1 ? "" : "s"} rising, none to flood levels yet` : by.WARNING + by.DANGER ? "No river rising to flood levels" : "All rivers normal";
  const snapshot = {
    river: { created_at: new Date().toISOString(), points: points.length, normal: by.NORMAL, rising: by.RISING, warning: by.WARNING, danger: by.DANGER, headline, flagged: flagged.slice(0, 40), statuses: rows },
    gandak: null,
    source: "JalNetra monitor (AWS Lambda + EventBridge Scheduler), GloFAS via Open-Meteo",
  };

  // notify only for rivers that were not already rising to flood levels in the previous snapshot
  let previousAlerts: string[] = [];
  try {
    const prev = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: KEY }));
    const body = JSON.parse(await prev.Body!.transformToString()) as { river?: { statuses?: Row[] } };
    previousAlerts = [...new Set((body.river?.statuses ?? []).filter((r) => (r[1] === "WARNING" || r[1] === "DANGER") && r[6] === "rising").map((r) => byId.get(r[0])?.river ?? ""))];
  } catch { /* first run */ }
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: KEY, Body: JSON.stringify(snapshot), ContentType: "application/json", CacheControl: "public, max-age=300" }));

  const fresh = alertRivers.filter((r) => !previousAlerts.includes(r));
  if (fresh.length && TOPIC_ARN) {
    await sns.send(new PublishCommand({ TopicArn: TOPIC_ARN, Subject: `JalNetra: ${fresh.length} river${fresh.length === 1 ? "" : "s"} rising to flood levels`.slice(0, 99), Message: `New rivers forecast to rise to High or above in the next 7 days: ${fresh.slice(0, 15).join(", ")}${fresh.length > 15 ? ` and ${fresh.length - 15} more` : ""}.\nOpen the live map to review. No call has been placed.` }));
  }
  return { points: rows.length, failed, by, headline, notified: fresh.length };
};
