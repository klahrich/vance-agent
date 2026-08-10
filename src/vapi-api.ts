import { env } from "./config.js";
import type { Mission } from "./missions/types.js";
import { composeSystemPrompt } from "./prompt/compose.js";
import { conductPlan } from "./vapi/conduct.js";

const API = "https://api.vapi.ai";

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env("VAPI_API_KEY")}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`Vapi ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

export interface VapiCallMessage {
  role?: string;
  message?: string;
  content?: string;
  secondsFromStart?: number;
  time?: number;
}

export interface VapiCall {
  id: string;
  status?: string;
  endedReason?: string;
  createdAt?: string;
  startedAt?: string;
  endedAt?: string;
  customer?: { number?: string };
  metadata?: Record<string, unknown>;
  monitor?: {
    listenUrl?: string;
    controlUrl?: string;
  };
  messages?: VapiCallMessage[];
  analysis?: {
    summary?: string;
    structuredData?: Record<string, unknown>;
  };
  artifact?: {
    messages?: VapiCallMessage[];
    transcript?: string;
    recordingUrl?: string;
    stereoRecordingUrl?: string;
  };
}

/**
 * Build the whole assistant inline rather than referencing a provisioned one.
 *
 * Missions differ in prompt, tools, voice, pacing and duration, which an
 * override on a baked assistant expresses badly. More importantly a
 * provisioned assistant drifts: the file and the Vapi resource disagree the
 * moment someone forgets to re-run a sync step. Building per call means
 * editing a mission file is the entire deploy story.
 */
export function buildAssistant(mission: Mission, contextText: string): Record<string, unknown> {
  const publicUrl = env("PUBLIC_BASE_URL").replace(/\/$/, "");
  const plan = conductPlan(mission.conduct);

  return {
    name: `Vance — ${mission.name}`,
    credentialIds: [env("VAPI_CUSTOM_LLM_CREDENTIAL_ID")],
    ...(mission.opens === "vance"
      ? { firstMessageMode: "assistant-speaks-first", firstMessage: mission.firstMessage }
      : { firstMessageMode: "assistant-waits-for-user" }),
    responseDelaySeconds: 0,
    // Long enough to survive a hold queue without the platform deciding the
    // call has died. CORE is what actually keeps Vance quiet during it.
    silenceTimeoutSeconds: Number(process.env.VAPI_SILENCE_TIMEOUT_SECONDS ?? 1800),
    maxDurationSeconds: mission.maxMinutes * 60,
    monitorPlan: { listenEnabled: true, controlEnabled: true },
    ...plan,
    model: {
      provider: "custom-llm",
      url: `${publicUrl}/v1/chat/completions`,
      model: "vance-pi",
      messages: [{ role: "system", content: composeSystemPrompt(mission, contextText) }],
      tools: mission.tools.map((type) => ({ type })),
      temperature: 0.2,
    },
    voice: {
      provider: process.env.VAPI_VOICE_PROVIDER ?? "vapi",
      voiceId: mission.voice ?? process.env.VAPI_VOICE_ID ?? "Elliot",
    },
    server: {
      url: `${publicUrl}/vapi/events`,
      ...(process.env.VAPI_WEBHOOK_CREDENTIAL_ID
        ? { credentialId: process.env.VAPI_WEBHOOK_CREDENTIAL_ID }
        : {}),
    },
    ...(mission.outcomeSchema
      ? {
          analysisPlan: {
            structuredDataSchema: mission.outcomeSchema,
            structuredDataPrompt: [
              `You are reading the transcript of a call whose purpose was: ${mission.description}.`,
              "Extract what was actually said into the given schema.",
              "",
              "Record only what the other person stated or clearly implied. If a",
              "field was never discussed, omit it or use null — do not infer it,",
              "do not fill it with something plausible, and do not carry over an",
              "assumption from the agent's own questions. A missing field is a",
              "useful signal that the call did not cover it; an invented one is",
              "worse than nothing, because it will be acted on.",
              "",
              "Quote or closely paraphrase their own words where the schema asks",
              "for description rather than a category.",
            ].join("\n"),
          },
        }
      : {}),
    serverMessages: [
      "status-update",
      "end-of-call-report",
      "hang",
      "transcript",
      "conversation-update",
    ],
  };
}

export async function createVapiCall(
  mission: Mission,
  destination: string,
  contextText: string,
): Promise<VapiCall> {
  return request("/call", {
    method: "POST",
    body: JSON.stringify({
      assistant: buildAssistant(mission, contextText),
      phoneNumberId: env("VAPI_PHONE_NUMBER_ID"),
      customer: { number: destination },
      metadata: { mission: mission.name, counterpart: mission.counterpart },
    }),
  });
}

export async function getVapiCall(callId: string): Promise<VapiCall> {
  return request(`/call/${encodeURIComponent(callId)}`, { method: "GET" });
}

/** `controlUrl` arrives in an API response, so treat it as untrusted input
 *  before POSTing to it. */
function controlEndpoint(call: VapiCall): string {
  const controlUrl = call.monitor?.controlUrl;
  if (!controlUrl) throw new Error("This call does not have live control enabled.");
  const parsed = new URL(controlUrl);
  if (parsed.protocol !== "https:" || !(parsed.hostname === "vapi.ai" || parsed.hostname.endsWith(".vapi.ai"))) {
    throw new Error("Vapi returned an invalid call control URL.");
  }
  return controlUrl;
}

async function control(call: VapiCall, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(controlEndpoint(call), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Vapi call control ${response.status}: ${await response.text()}`);
}

export async function endVapiCall(call: VapiCall): Promise<void> {
  await control(call, { type: "end-call" });
}

/**
 * Redirect a call in flight, without the other party hearing anything.
 *
 * This is what makes supervised calls worth running: a prompt that is subtly
 * wrong can be corrected at minute four instead of discovered in the
 * transcript afterwards.
 */
export async function steerVapiCall(call: VapiCall, instruction: string): Promise<void> {
  await control(call, {
    type: "add-message",
    message: { role: "system", content: instruction },
    triggerResponseEnabled: true,
  });
}

/** One-time setup: the credential that lets Vapi authenticate to our
 *  custom-LLM endpoint. Everything else about an assistant is now built per
 *  call, so this is all that remains of provisioning. */
export async function provisionCustomLlmCredential(): Promise<string> {
  const credential = await request<{ id: string }>("/credential", {
    method: "POST",
    body: JSON.stringify({
      provider: "custom-llm",
      apiKey: env("PI_SERVER_API_KEY"),
    }),
  });
  return credential.id;
}
