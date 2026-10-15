export type AlertChannel = "call" | "sms";
export type TelephonyProvider = "omnidimension" | "twilio" | "not_configured";

export type DispatchOptions = { timeoutMs?: number };
type Target = { id: string | null; name: string; phone: string };
type AlertContext = { place?: string; title?: string; source?: string; observed?: string; safe_place?: string };

const env = (name: string, ...aliases: string[]): string | undefined => {
  for (const key of [name, ...aliases]) {
    const value = process.env[key];
    if (value) return value;
  }
  return undefined;
};

export function telephonyConfig() {
  return {
    omnidimKey: env("OMNIDIM_KEY", "OMNIDIM_API_KEY"),
    omnidimAgent: env("OMNIDIM_AGENT", "OMNIDIM_AGENT_ID"),
    omnidimFrom: env("OMNIDIM_FROM", "OMNIDIM_FROM_NUMBER_ID"),
    twilioSid: env("TWILIO_SID", "TWILIO_ACCOUNT_SID"),
    twilioToken: env("TWILIO_TOKEN", "TWILIO_AUTH_TOKEN"),
    twilioFrom: env("TWILIO_FROM", "TWILIO_FROM_NUMBER"),
    alertPhone: env("ALERT_PHONE", "JN_ALERT_PHONE"),
  };
}

export function selectedProvider(channel: AlertChannel): TelephonyProvider {
  const config = telephonyConfig();
  if (channel === "call" && config.omnidimKey && config.omnidimAgent) return "omnidimension";
  if (config.twilioSid && config.twilioToken && config.twilioFrom) return "twilio";
  return "not_configured";
}

function escapeXml(value: string): string {
  return value.replace(/[<>&'\"]/g, (character) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "'": "&apos;",
    '"': "&quot;",
  })[character] ?? character);
}

export async function dispatchAlert(
  provider: TelephonyProvider,
  channel: AlertChannel,
  target: Target,
  message: string,
  context: AlertContext,
  incidentId: string,
  options: DispatchOptions = {},
): Promise<{ status: "sent" | "failed" | "not_configured" | "unknown"; providerRef: string | null; error: string | null }> {
  if (provider === "not_configured") return { status: "not_configured", providerRef: null, error: null };
  const config = telephonyConfig();
  // Strict mode is opt-in (callers that pass timeoutMs, i.e. the demo workflow). Without it every
  // path below behaves exactly as before: any thrown error or non-2xx response is "failed".
  // In strict mode an aborted request, a network error or a 5xx response is "unknown": the provider
  // may have accepted the call, so it must never be reported as a clean failure or retried.
  const strict = options.timeoutMs !== undefined;
  const controller = strict ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), options.timeoutMs) : undefined;
  const signal = controller ? { signal: controller.signal } : {};
  const failedStatus = (httpStatus: number): "failed" | "unknown" => (strict && httpStatus >= 500 ? "unknown" : "failed");

  try {
    if (provider === "omnidimension") {
      const response = await fetch("https://omnidim.io/api/v1/calls/dispatch", {
        method: "POST",
        ...signal,
        headers: { Authorization: `Bearer ${config.omnidimKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: Number(config.omnidimAgent),
          to_number: target.phone,
          ...(config.omnidimFrom ? { from_number_id: Number(config.omnidimFrom) } : {}),
          call_context: {
            alert_message: message,
            place: context.place ?? "",
            incident_title: context.title ?? "",
            source: context.source ?? "",
            observed: context.observed ?? "",
            safe_place: context.safe_place ?? "not available",
          },
          metadata: { incident_id: incidentId, contact_id: target.id },
        }),
      });
      const payload = await response.json().catch(() => ({})) as { success?: boolean; requestId?: string; message?: string; error?: string };
      if (response.ok && payload.success !== false) return { status: "sent", providerRef: String(payload.requestId ?? ""), error: null };
      return { status: failedStatus(response.status), providerRef: null, error: payload.message ?? payload.error ?? `OmniDimension error ${response.status}` };
    }

    const form = new URLSearchParams({ To: target.phone, From: config.twilioFrom! });
    if (channel === "call") {
      const say = escapeXml(message);
      form.set("Twiml", `<Response><Say language="hi-IN" voice="Polly.Aditi">${say}</Say><Pause length="1"/><Say language="hi-IN" voice="Polly.Aditi">${say}</Say></Response>`);
    } else {
      form.set("Body", message);
    }
    const resource = channel === "call" ? "Calls" : "Messages";
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.twilioSid}/${resource}.json`, {
      method: "POST",
      ...signal,
      body: form,
      headers: { Authorization: `Basic ${Buffer.from(`${config.twilioSid}:${config.twilioToken}`).toString("base64")}` },
    });
    const payload = await response.json().catch(() => ({})) as { sid?: string; message?: string };
    if (response.ok) return { status: "sent", providerRef: payload.sid ?? null, error: null };
    return { status: failedStatus(response.status), providerRef: null, error: payload.message ?? `Twilio error ${response.status}` };
  } catch (error) {
    return { status: strict ? "unknown" : "failed", providerRef: null, error: String(error) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
