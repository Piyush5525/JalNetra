// JalNetra shared incident API (Supabase Edge Function).
// Every part of JalNetra (flood, urban CV, citizen app, leak sensors) talks to this one API.
// Auth: header `x-jalnetra-key` with a team key. Reporters can create and read; operators can also change status.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-jalnetra-key, authorization, apikey",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const TYPES = ["river_flood", "waterlogging", "pothole", "leak"];
const SEVERITY = ["low", "medium", "high"];
const SOURCES = ["satellite", "forecast", "cctv", "dashcam", "app", "whatsapp", "sms", "call", "sensor"];
const SLA_HOURS: Record<string, number> = { high: 6, medium: 24, low: 72 };
// incident lifecycle: which status can follow which
const NEXT: Record<string, string[]> = {
  detected: ["approved", "rejected"],
  approved: ["ticketed", "rejected"],
  ticketed: ["fixed_claimed", "escalated"],
  fixed_claimed: ["verified", "reopened"],
  reopened: ["ticketed", "escalated"],
  escalated: ["ticketed", "fixed_claimed"],
  rejected: [],
  verified: [],
};
const OPEN = ["detected", "approved", "ticketed", "reopened", "escalated", "fixed_claimed"];

async function sha256(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = Math.PI / 180, dl = (b.lat - a.lat) * r, dn = (b.lng - a.lng) * r;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(h));
}
const withFlags = (i: Record<string, any>) => ({ ...i, overdue: !!i.sla_due && OPEN.includes(i.status) && i.status !== "fixed_claimed" && new Date(i.sla_due) < new Date() });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/jalnetra-api/, "") || "/";
  if (path === "/health") return json({ ok: true, time: new Date().toISOString() });

  const key = req.headers.get("x-jalnetra-key");
  if (!key) return json({ error: "Missing x-jalnetra-key header" }, 401);
  const { data: who } = await db.from("jn_api_keys").select("owner, role").eq("key_hash", await sha256(key)).maybeSingle();
  if (!who) return json({ error: "Unknown API key" }, 401);

  // POST /incidents : create, or merge into a matching open incident nearby
  if (req.method === "POST" && path === "/incidents") {
    let b: any;
    try { b = await req.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
    const errs: string[] = [];
    if (!TYPES.includes(b.incident_type)) errs.push(`incident_type must be one of ${TYPES.join(", ")}`);
    if (!SEVERITY.includes(b.severity)) errs.push(`severity must be one of ${SEVERITY.join(", ")}`);
    if (!SOURCES.includes(b.source)) errs.push(`source must be one of ${SOURCES.join(", ")}`);
    if (typeof b.lat !== "number" || typeof b.lng !== "number") errs.push("lat and lng must be numbers");
    if (b.confidence !== undefined && (typeof b.confidence !== "number" || b.confidence < 0 || b.confidence > 1)) errs.push("confidence must be between 0 and 1");
    if (errs.length) return json({ error: "Invalid incident", details: errs }, 400);

    const radius = b.incident_type === "river_flood" ? 3000 : 150;
    const since = new Date(Date.now() - 6 * 3600e3).toISOString();
    const { data: near } = await db.from("jn_incidents").select("*").eq("incident_type", b.incident_type).in("status", OPEN)
      .gte("updated_at", since).gte("lat", b.lat - 0.03).lte("lat", b.lat + 0.03).gte("lng", b.lng - 0.03).lte("lng", b.lng + 0.03);
    const dup = (near ?? []).find((i) => metres(i, b) <= radius);
    if (dup) {
      const conf = Math.min(1, Math.max(dup.confidence, b.confidence ?? 0.5) + 0.05);
      const sev = SEVERITY.indexOf(b.severity) > SEVERITY.indexOf(dup.severity) ? b.severity : dup.severity;
      const tighter = new Date(Date.now() + SLA_HOURS[sev] * 3600e3).toISOString();
      const sla = dup.sla_due && dup.sla_due < tighter ? dup.sla_due : tighter;
      const { data: upd } = await db.from("jn_incidents").update({ reports: dup.reports + 1, confidence: conf, severity: sev, sla_due: sla, updated_at: new Date().toISOString() }).eq("id", dup.id).select().single();
      await db.from("jn_events").insert({ incident_id: dup.id, action: "duplicate_report", actor: who.owner, note: `Another report from ${b.source}`, data: { evidence_url: b.evidence_url ?? null } });
      return json({ merged: true, incident: withFlags(upd) }, 200);
    }
    const row = {
      incident_type: b.incident_type, severity: b.severity, confidence: b.confidence ?? 0.5, lat: b.lat, lng: b.lng,
      observed_at: b.observed_at ?? new Date().toISOString(), source: b.source, language: b.language ?? "hi", title: b.title ?? null,
      evidence_url: b.evidence_url ?? null, details: b.details ?? {}, reported_by: who.owner,
      sla_due: new Date(Date.now() + SLA_HOURS[b.severity] * 3600e3).toISOString(),
    };
    const { data: ins, error } = await db.from("jn_incidents").insert(row).select().single();
    if (error) return json({ error: error.message }, 500);
    await db.from("jn_events").insert({ incident_id: ins.id, action: "detected", actor: who.owner, note: b.title ?? null, data: { source: b.source } });
    return json({ merged: false, incident: withFlags(ins) }, 201);
  }

  // GET /incidents?type=&status=&bbox=w,s,e,n&limit=
  if (req.method === "GET" && path === "/incidents") {
    let q = db.from("jn_incidents").select("*").order("created_at", { ascending: false }).limit(Math.min(Number(url.searchParams.get("limit") ?? 200), 1000));
    const t = url.searchParams.get("type"), s = url.searchParams.get("status"), bbox = url.searchParams.get("bbox");
    if (t) q = q.in("incident_type", t.split(","));
    if (s) q = q.in("status", s.split(","));
    if (bbox) { const [w, so, e, n] = bbox.split(",").map(Number); q = q.gte("lng", w).lte("lng", e).gte("lat", so).lte("lat", n) }
    const { data, error } = await q;
    if (error) return json({ error: error.message }, 500);
    return json({ incidents: (data ?? []).map(withFlags) });
  }

  const m = path.match(/^\/incidents\/([0-9a-f-]{36})$/);
  // GET /incidents/:id  -> incident with its full event history
  if (req.method === "GET" && m) {
    const { data: inc } = await db.from("jn_incidents").select("*").eq("id", m[1]).maybeSingle();
    if (!inc) return json({ error: "Incident not found" }, 404);
    const { data: ev } = await db.from("jn_events").select("*").eq("incident_id", m[1]).order("created_at");
    return json({ incident: withFlags(inc), events: ev ?? [] });
  }
  // PATCH /incidents/:id {status, note, evidence_url}  -> operators move an incident through its lifecycle
  if (req.method === "PATCH" && m) {
    if (who.role !== "operator") return json({ error: "Only operator keys can change status" }, 403);
    let b: any;
    try { b = await req.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
    const { data: inc } = await db.from("jn_incidents").select("*").eq("id", m[1]).maybeSingle();
    if (!inc) return json({ error: "Incident not found" }, 404);
    if (!NEXT[inc.status]?.includes(b.status)) return json({ error: `Cannot move from ${inc.status} to ${b.status}`, allowed: NEXT[inc.status] }, 409);
    const patch: Record<string, unknown> = { status: b.status, updated_at: new Date().toISOString() };
    if (b.status === "reopened") patch.sla_due = new Date(Date.now() + SLA_HOURS[inc.severity] * 3600e3).toISOString();
    const { data: upd } = await db.from("jn_incidents").update(patch).eq("id", inc.id).select().single();
    await db.from("jn_events").insert({ incident_id: inc.id, action: b.status, actor: who.owner, note: b.note ?? null, data: { evidence_url: b.evidence_url ?? null } });
    return json({ incident: withFlags(upd) });
  }
  // POST /incidents/:id/evidence {note, data, evidence_url} -> attach evidence (e.g. a newer satellite pass) without changing status
  const ev = path.match(/^\/incidents\/([0-9a-f-]{36})\/evidence$/);
  if (req.method === "POST" && ev) {
    let b: any;
    try { b = await req.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
    if (!b.note) return json({ error: "note is required" }, 400);
    const { data: inc } = await db.from("jn_incidents").select("id").eq("id", ev[1]).maybeSingle();
    if (!inc) return json({ error: "Incident not found" }, 404);
    await db.from("jn_events").insert({ incident_id: inc.id, action: "evidence", actor: who.owner, note: b.note, data: { ...(b.data ?? {}), evidence_url: b.evidence_url ?? null } });
    await db.from("jn_incidents").update({ updated_at: new Date().toISOString() }).eq("id", inc.id);
    return json({ ok: true }, 201);
  }

  // GET /telephony -> which provider is active and the masked demo phone
  if (path === "/telephony" && req.method === "GET") {
    const { data: cfg } = await db.from("jn_config").select("key, value").in("key", ["omnidim_key", "omnidim_agent", "twilio_sid", "alert_phone"]);
    const c = Object.fromEntries((cfg ?? []).map((r) => [r.key, r.value]));
    return json({ call: c.omnidim_key && c.omnidim_agent ? "omnidimension" : c.twilio_sid ? "twilio" : "not_configured", demo_phone: c.alert_phone ? c.alert_phone.slice(0, 3) + "******" + c.alert_phone.slice(-4) : null });
  }

  // GET /contacts?lat=&lng=&km=  and  POST /contacts (operator)
  if (path === "/contacts" && req.method === "GET") {
    const lat = Number(url.searchParams.get("lat")), lng = Number(url.searchParams.get("lng")), km = Number(url.searchParams.get("km") ?? 15);
    const { data } = await db.from("jn_contacts").select("*").order("created_at", { ascending: false }).limit(1000);
    let rows = data ?? [];
    if (Number.isFinite(lat) && Number.isFinite(lng) && url.searchParams.has("lat")) rows = rows.map((c) => ({ ...c, km: metres(c, { lat, lng }) / 1000 })).filter((c) => c.km <= km).sort((a, b) => a.km - b.km);
    return json({ contacts: rows });
  }
  if (path === "/contacts" && req.method === "POST") {
    if (who.role !== "operator") return json({ error: "Only operator keys can add contacts" }, 403);
    let b: any;
    try { b = await req.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
    const row = { name: b.name, role: b.role, phone: String(b.phone ?? "").replace(/[\s-]/g, ""), place_name: b.place_name, district: b.district ?? null, lat: b.lat, lng: b.lng, language: b.language ?? "hi", added_by: who.owner };
    const { data, error } = await db.from("jn_contacts").insert(row).select().single();
    if (error) return json({ error: "Invalid contact: name, role (sarpanch|asha|ngo|official|volunteer), phone in +91... format, place_name, lat, lng are required", details: error.message }, 400);
    return json({ contact: data }, 201);
  }

  // POST /incidents/:id/alerts {contact_ids, message, channel} (operator) -> Hindi voice call or SMS through Twilio when configured
  const al = path.match(/^\/incidents\/([0-9a-f-]{36})\/alerts$/);
  if (al && req.method === "GET") {
    const { data } = await db.from("jn_alerts").select("*, jn_contacts(name, role, phone, place_name)").eq("incident_id", al[1]).order("created_at", { ascending: false });
    return json({ alerts: data ?? [] });
  }
  if (al && req.method === "POST") {
    if (who.role !== "operator") return json({ error: "Only operator keys can send alerts" }, 403);
    let b: any;
    try { b = await req.json(); } catch { return json({ error: "Body must be JSON" }, 400); }
    const channel = b.channel === "sms" ? "sms" : "call";
    if ((!Array.isArray(b.contact_ids) || !b.contact_ids.length) && !b.demo) return json({ error: "Pick at least one contact" }, 400);
    if (!b.message) return json({ error: "message is required" }, 400);
    const { data: inc } = await db.from("jn_incidents").select("id, status").eq("id", al[1]).maybeSingle();
    if (!inc) return json({ error: "Incident not found" }, 404);
    // Ticketed is the legacy name used by existing approved incidents.
    if (!["approved", "ticketed", "contacted", "evacuating"].includes(inc.status)) {
      return json({ error: `Incident must be approved before sending alerts (current status: ${inc.status})` }, 409);
    }
    const { data: contacts } = b.contact_ids?.length ? await db.from("jn_contacts").select("*").in("id", b.contact_ids) : { data: [] as any[] };
    if (!b.demo && (contacts ?? []).length === 0) return json({ error: "No matching alert contacts found" }, 400);
    const { data: cfg } = await db.from("jn_config").select("key, value");
    const c = Object.fromEntries((cfg ?? []).map((r) => [r.key, r.value]));
    const omni = c.omnidim_key && c.omnidim_agent;
    const twilio = c.twilio_sid && c.twilio_token && c.twilio_from;
    const provider = channel === "call" && omni ? "omnidimension" : twilio ? "twilio" : "not_configured";
    const esc = (s: string) => s.replace(/[<>&'"]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[ch]!));
    // the demo phone from config can be called as an extra recipient
    const targets: { id: string | null; name: string; phone: string }[] = (contacts ?? []).map((x) => ({ id: x.id, name: x.name, phone: x.phone }));
    if (b.demo && c.alert_phone) targets.push({ id: null, name: "Demo phone", phone: c.alert_phone });
    if (targets.length === 0) return json({ error: "No alert recipients configured" }, 400);
    const results = [];
    for (const ct of targets) {
      let status = "not_configured", ref: string | null = null, err: string | null = null;
      try {
        if (provider === "omnidimension") {
          const r = await fetch("https://omnidim.io/api/v1/calls/dispatch", {
            method: "POST", headers: { Authorization: `Bearer ${c.omnidim_key}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              agent_id: Number(c.omnidim_agent), to_number: ct.phone, ...(c.omnidim_from ? { from_number_id: Number(c.omnidim_from) } : {}),
              call_context: { alert_message: b.message, place: b.context?.place ?? "", incident_title: b.context?.title ?? "", source: b.context?.source ?? "", observed: b.context?.observed ?? "", safe_place: b.context?.safe_place ?? "not available" },
              metadata: { incident_id: inc.id, contact_id: ct.id },
            }),
          });
          const j = await r.json().catch(() => ({}));
          if (r.ok && j.success !== false) { status = "sent"; ref = String(j.requestId ?? "") } else { status = "failed"; err = j.message ?? j.error ?? `OmniDimension error ${r.status}` }
        } else if (provider === "twilio") {
          const form = new URLSearchParams({ To: ct.phone, From: c.twilio_from });
          if (channel === "call") form.set("Twiml", `<Response><Say language="hi-IN" voice="Polly.Aditi">${esc(b.message)}</Say><Pause length="1"/><Say language="hi-IN" voice="Polly.Aditi">${esc(b.message)}</Say></Response>`);
          else form.set("Body", b.message);
          const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.twilio_sid}/${channel === "call" ? "Calls" : "Messages"}.json`, { method: "POST", body: form, headers: { Authorization: "Basic " + btoa(`${c.twilio_sid}:${c.twilio_token}`) } });
          const j = await r.json().catch(() => ({}));
          if (r.ok) { status = "sent"; ref = j.sid ?? null } else { status = "failed"; err = j.message ?? `Twilio error ${r.status}` }
        }
      } catch (e) { status = "failed"; err = String(e) }
      await db.from("jn_alerts").insert({ incident_id: inc.id, contact_id: ct.id, channel, message: b.message, status, provider_ref: ref, error: err, sent_by: who.owner });
      results.push({ contact: ct.name, phone: ct.phone, status, error: err });
    }
    await db.from("jn_events").insert({ incident_id: inc.id, action: "alert", actor: who.owner, note: `${channel === "call" ? "Voice call" : "SMS"} to ${results.length} contact(s): ${results.filter((r) => r.status === "sent").length} sent`, data: { results } });
    return json({ telephony: provider, results });
  }

  return json({ error: `No route for ${req.method} ${path}` }, 404);
});
