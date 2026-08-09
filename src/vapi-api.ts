import { env } from "./config.js";
import { VANCE_SYSTEM_PROMPT } from "./vapi-prompt.js";

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
  monitor?: {
    listenUrl?: string;
    controlUrl?: string;
  };
  messages?: VapiCallMessage[];
  artifact?: {
    messages?: VapiCallMessage[];
    transcript?: string;
    recordingUrl?: string;
    stereoRecordingUrl?: string;
  };
}

export async function createVapiCall(destination: string, profileText: string): Promise<VapiCall> {
  return request("/call", {
    method: "POST",
    body: JSON.stringify({
      assistantId: env("VAPI_ASSISTANT_ID"),
      phoneNumberId: env("VAPI_PHONE_NUMBER_ID"),
      customer: { number: destination },
      metadata: { initiatedBy: "vance-dashboard" },
      assistantOverrides: { variableValues: { profile_text: profileText } },
    }),
  });
}

export async function getVapiCall(callId: string): Promise<VapiCall> {
  return request(`/call/${encodeURIComponent(callId)}`, { method: "GET" });
}

export async function endVapiCall(call: VapiCall): Promise<void> {
  const controlUrl = call.monitor?.controlUrl;
  if (!controlUrl) throw new Error("This call does not have live control enabled.");

  const parsed = new URL(controlUrl);
  if (parsed.protocol !== "https:" || !(parsed.hostname === "vapi.ai" || parsed.hostname.endsWith(".vapi.ai"))) {
    throw new Error("Vapi returned an invalid call control URL.");
  }

  const response = await fetch(controlUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "end-call" }),
  });
  if (!response.ok) throw new Error(`Vapi call control ${response.status}: ${await response.text()}`);
}

export async function provisionVapi(): Promise<{ assistantId: string; customLlmCredentialId: string }> {
  const publicUrl = env("PUBLIC_BASE_URL").replace(/\/$/, "");
  const customLlmCredential = await request<{ id: string }>("/credential", {
    method: "POST",
    body: JSON.stringify({
      provider: "custom-llm",
      apiKey: env("PI_SERVER_API_KEY"),
    }),
  });
  const webhookCredentialId = process.env.VAPI_WEBHOOK_CREDENTIAL_ID;
  const eventServer = {
    url: `${publicUrl}/vapi/events`,
    ...(webhookCredentialId ? { credentialId: webhookCredentialId } : {}),
  };

  const assistant = await request<{ id: string }>("/assistant", {
    method: "POST",
    body: JSON.stringify({
      name: "Vance Pi Agent",
      credentialIds: [customLlmCredential.id],
      firstMessageMode: "assistant-waits-for-user",
      responseDelaySeconds: 0,
      silenceTimeoutSeconds: Number(process.env.VAPI_SILENCE_TIMEOUT_SECONDS ?? 1800),
      maxDurationSeconds: Number(process.env.VAPI_MAX_DURATION_SECONDS ?? 43200),
      monitorPlan: { listenEnabled: true, controlEnabled: true },
      startSpeakingPlan: {
        waitSeconds: 0.15,
        smartEndpointingPlan: { provider: "vapi" },
      },
      stopSpeakingPlan: {
        numWords: 2,
        voiceSeconds: 0.2,
        backoffSeconds: 0.8,
        acknowledgementPhrases: ["okay", "right", "yeah", "yes", "uh-huh", "mm-hmm", "got it", "sure", "alright"],
      },
      model: {
        provider: "custom-llm",
        url: `${publicUrl}/v1/chat/completions`,
        model: "vance-pi",
        messages: [{ role: "system", content: VANCE_SYSTEM_PROMPT }],
        tools: [{ type: "dtmf" }, { type: "endCall" }],
        temperature: 0.2,
      },
      voice: {
        provider: process.env.VAPI_VOICE_PROVIDER ?? "vapi",
        voiceId: process.env.VAPI_VOICE_ID ?? "Elliot",
      },
      server: eventServer,
      serverMessages: ["status-update", "end-of-call-report", "hang", "assistant.started"],
    }),
  });

  return { assistantId: assistant.id, customLlmCredentialId: customLlmCredential.id };
}

export async function startVapiCall(profileId: string, profileText: string, assistantId: string): Promise<{
  id: string;
  status?: string;
  monitor?: { listenUrl?: string; controlUrl?: string };
}> {
  return request("/call", {
    method: "POST",
    body: JSON.stringify({
      assistantId,
      phoneNumberId: env("VAPI_PHONE_NUMBER_ID"),
      customer: { number: env("BELL_PHONE_NUMBER") },
      metadata: { profileId },
      assistantOverrides: { variableValues: { profile_text: profileText } },
    }),
  });
}
