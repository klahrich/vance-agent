import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { loadContextText } from "./config.js";
import { isMissionName, listMissions, loadMission } from "./missions/loader.js";
import { SseChunkWriter, completeWithPi, openAiCompletion } from "./pi-llm.js";
import type { OpenAiChatRequest, PiCompletion } from "./types.js";
import {
  createVapiCall,
  endVapiCall,
  getVapiCall,
  steerVapiCall,
  type VapiCall,
  type VapiCallMessage,
} from "./vapi-api.js";

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function bearerMatches(req: IncomingMessage, expected: string | undefined): boolean {
  if (!expected) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function normalizePhoneNumber(input: unknown): string {
  if (typeof input !== "string") throw new Error("Enter a phone number.");
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (trimmed.startsWith("+") && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  throw new Error("Use a valid phone number, including country code when outside Canada or the US.");
}

function dashboardAuthorized(req: IncomingMessage): boolean {
  const dashboardKey = process.env.DASHBOARD_KEY;
  return Boolean(dashboardKey) && bearerMatches(req, dashboardKey);
}

interface DashboardMessage {
  role: "vance" | "them";
  message: string;
  secondsFromStart?: number;
  partial?: boolean;
}

interface LiveTranscript {
  messages: DashboardMessage[];
  partial?: DashboardMessage;
  assistantDraft?: DashboardMessage & { turn?: number };
  /** Extraction arrives once, on end-of-call-report, and is what the call was
   *  for on an elicitation mission. Held here so the dashboard can show it
   *  without re-fetching, and logged so it survives this process. */
  analysis?: { summary?: string; structuredData?: Record<string, unknown> };
  updatedAt: number;
}

const liveTranscripts = new Map<string, LiveTranscript>();
const liveSubscribers = new Map<string, Set<ServerResponse>>();

function normalizeMessages(entries: VapiCallMessage[]): DashboardMessage[] {
  return entries.flatMap((entry: VapiCallMessage) => {
    const role = entry.role?.toLowerCase();
    const message = entry.message ?? entry.content;
    if (!message || !role || !["user", "customer", "assistant", "bot"].includes(role)) return [];
    return [{
      role: role === "assistant" || role === "bot" ? "vance" as const : "them" as const,
      message,
      secondsFromStart: entry.secondsFromStart ?? entry.time,
    }];
  });
}

function mergedMessages(call: VapiCall): DashboardMessage[] {
  const stored = normalizeMessages(call.messages ?? call.artifact?.messages ?? []);
  const live = liveTranscripts.get(call.id);
  if (!live) return stored;

  const messages = live.messages.length >= stored.length ? [...live.messages] : stored;
  for (const draft of [live.partial, live.assistantDraft]) {
    if (!draft?.message) continue;
    const previous = messages.at(-1);
    if (previous?.role === draft.role && previous.message === draft.message) continue;
    messages.push(draft);
  }
  return messages;
}

function dashboardCall(call: VapiCall): unknown {
  const messages = mergedMessages(call);

  return {
    id: call.id,
    status: call.status ?? "unknown",
    endedReason: call.endedReason,
    createdAt: call.createdAt,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    destination: call.customer?.number,
    mission: call.metadata?.mission,
    counterpart: call.metadata?.counterpart,
    monitor: call.monitor,
    messages,
    transcript: call.artifact?.transcript,
    recordingUrl: call.artifact?.stereoRecordingUrl ?? call.artifact?.recordingUrl,
    // Vapi runs extraction after the call ends, so this arrives on the
    // webhook slightly before a polled GET reflects it — prefer whichever we
    // already have.
    analysis: liveTranscripts.get(call.id)?.analysis ?? call.analysis,
  };
}

function secondsFromCallStart(call: VapiCall | undefined): number | undefined {
  const started = Date.parse(call?.startedAt ?? call?.createdAt ?? "");
  return Number.isFinite(started) ? Math.max(0, (Date.now() - started) / 1000) : undefined;
}

function liveTranscript(callId: string): LiveTranscript {
  const existing = liveTranscripts.get(callId);
  if (existing) return existing;
  const created: LiveTranscript = { messages: [], updatedAt: Date.now() };
  liveTranscripts.set(callId, created);
  return created;
}

function broadcastCall(call: VapiCall): void {
  const subscribers = liveSubscribers.get(call.id);
  if (!subscribers?.size) return;
  const data = `data: ${JSON.stringify(dashboardCall(call))}\n\n`;
  for (const subscriber of subscribers) subscriber.write(data);
}

function acceptLiveSubscriber(callId: string, req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 1000\n\n");
  const subscribers = liveSubscribers.get(callId) ?? new Set<ServerResponse>();
  subscribers.add(res);
  liveSubscribers.set(callId, subscribers);

  const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 15_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    subscribers.delete(res);
    if (!subscribers.size) liveSubscribers.delete(callId);
  });
}

function handleVapiEvent(payload: any): void {
  const message = payload?.message;
  const call = message?.call as VapiCall | undefined;
  const callId = call?.id;
  if (!callId) return;
  const live = liveTranscript(callId);
  const secondsFromStart = secondsFromCallStart(call);

  if (message.type === "conversation-update" && Array.isArray(message.messages)) {
    live.messages = normalizeMessages(message.messages);
    live.partial = undefined;
    const last = live.messages.at(-1);
    if (last?.role === "vance") live.assistantDraft = undefined;
  }

  if (message.type === "transcript" || String(message.type).startsWith("transcript[")) {
    const role = message.role === "assistant" || message.role === "bot" ? "vance" : "them";
    const next: DashboardMessage = {
      role,
      message: message.transcript ?? message.originalTranscript ?? "",
      secondsFromStart,
      partial: message.transcriptType !== "final",
    };
    if (next.message) {
      if (message.transcriptType === "final") {
        const last = live.messages.at(-1);
        if (last?.role !== next.role || last.message !== next.message) live.messages.push({ ...next, partial: false });
        live.partial = undefined;
      } else {
        live.partial = next;
      }
    }
  }

  if (message.type === "assistant.speechStarted" && message.text) {
    live.assistantDraft = {
      role: "vance",
      message: message.text,
      secondsFromStart,
      partial: true,
      turn: message.turn,
    };
  }

  if (message.type === "end-of-call-report") {
    if (Array.isArray(message.artifact?.messages)) {
      live.messages = normalizeMessages(message.artifact.messages);
      live.partial = undefined;
      live.assistantDraft = undefined;
    }
    const analysis = message.analysis ?? call?.analysis;
    if (analysis?.structuredData || analysis?.summary) {
      live.analysis = { summary: analysis.summary, structuredData: analysis.structuredData };
      // Logged in full because this is the deliverable. The in-memory copy is
      // dropped ten minutes after the call, and Vapi's own retention is the
      // only other place it lives until persistence exists.
      console.log(JSON.stringify({ event: "outcome", callId, analysis: live.analysis }));
    }
  }

  live.updatedAt = Date.now();
  if (message.status) call.status = message.status;
  if (message.endedReason) call.endedReason = message.endedReason;
  broadcastCall(call);

  if (message.type === "end-of-call-report" || message.status === "ended") {
    setTimeout(() => liveTranscripts.delete(callId), 10 * 60_000).unref();
  }
}

function captureLlmConversation(request: OpenAiChatRequest, completion?: PiCompletion): void {
  const callId = request.call?.id;
  if (!callId) return;
  const live = liveTranscript(callId);
  live.messages = normalizeMessages((request.messages ?? []).flatMap((message) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    if (typeof message.content !== "string" || !message.content.trim()) return [];
    return [{ role: message.role, message: message.content }];
  }));
  live.partial = undefined;
  live.assistantDraft = undefined;

  if (completion?.text) {
    const next: DashboardMessage = {
      role: "vance",
      message: completion.text,
      secondsFromStart: secondsFromCallStart(request.call as VapiCall),
    };
    const last = live.messages.at(-1);
    if (last?.role !== next.role || last.message !== next.message) live.messages.push(next);
  }

  live.updatedAt = Date.now();
  broadcastCall({
    ...request.call,
    id: callId,
    messages: [],
  });
}

const contentTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const name = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!/^[a-zA-Z0-9._/-]+$/.test(name) || name.includes("..")) return json(res, 404, { error: "Not found" });
  try {
    const body = await readFile(resolve(process.cwd(), "public", name));
    res.writeHead(200, {
      "content-type": contentTypes[extname(name)] ?? "application/octet-stream",
      "cache-control": name === "index.html" ? "no-cache" : "public, max-age=300",
      "content-security-policy": "default-src 'self'; connect-src 'self' wss://*.vapi.ai; style-src 'self'; script-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(body);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/health") return json(res, 200, { ok: true, brain: "pi" });

    if (pathname === "/api/session" && req.method === "GET") {
      if (!dashboardAuthorized(req)) return json(res, 401, { error: "That passcode did not work." });
      return json(res, 200, {
        ok: true,
        callerNumber: process.env.VANCE_CALLER_NUMBER ?? "",
        defaultDestination: process.env.DEFAULT_DESTINATION ?? "",
        missions: await listMissions(),
      });
    }

    if (pathname === "/api/calls" && req.method === "POST") {
      if (!dashboardAuthorized(req)) return json(res, 401, { error: "That passcode did not work." });
      const body = await readBody(req) as { destination?: unknown; mission?: unknown; context?: unknown };
      if (!isMissionName(body.mission)) return json(res, 400, { error: "Pick a mission." });
      const mission = await loadMission(body.mission);
      // Typed into the dashboard for this call; otherwise a file named after
      // the mission, so a standing context (an account, a client) does not
      // have to be re-pasted every time.
      const contextText =
        typeof body.context === "string" && body.context.trim()
          ? body.context
          : await loadContextText(mission.name).catch(() => process.env.VANCE_CONTEXT_TEXT ?? "");
      const call = await createVapiCall(mission, normalizePhoneNumber(body.destination), contextText);
      liveTranscript(call.id);
      return json(res, 201, dashboardCall(call));
    }

    const callRoute = pathname.match(/^\/api\/calls\/([0-9a-f-]+)(\/(?:hangup|live|steer))?$/i);
    if (callRoute) {
      if (!dashboardAuthorized(req)) return json(res, 401, { error: "That passcode did not work." });
      const callId = callRoute[1];
      if (!callId || !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(callId)) return json(res, 400, { error: "Invalid call id." });
      if (req.method === "GET" && !callRoute[2]) {
        return json(res, 200, dashboardCall(await getVapiCall(callId)));
      }
      if (req.method === "GET" && callRoute[2] === "/live") {
        acceptLiveSubscriber(callId, req, res);
        return;
      }
      if (req.method === "POST" && callRoute[2] === "/hangup") {
        const call = await getVapiCall(callId);
        if (call.status === "ended") return json(res, 200, dashboardCall(call));
        await endVapiCall(call);
        return json(res, 202, { ok: true, status: "ending" });
      }
      if (req.method === "POST" && callRoute[2] === "/steer") {
        const body = await readBody(req) as { instruction?: unknown };
        const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
        if (!instruction) return json(res, 400, { error: "Write an instruction first." });
        const call = await getVapiCall(callId);
        if (call.status === "ended") return json(res, 409, { error: "That call has already ended." });
        await steerVapiCall(call, instruction);
        return json(res, 202, { ok: true });
      }
    }

    if (req.method === "POST" && pathname === "/v1/chat/completions") {
      const serverKey = process.env.PI_SERVER_API_KEY;
      if (!serverKey || !bearerMatches(req, serverKey)) return json(res, 401, { error: { message: "Unauthorized" } });
      const request = await readBody(req) as OpenAiChatRequest;
      captureLlmConversation(request);

      if (!request.stream) {
        const completion = await completeWithPi(request);
        captureLlmConversation(request, completion);
        return json(res, 200, openAiCompletion(completion));
      }

      // Forward text the instant the model produces it. Vapi cannot begin
      // synthesising until a chunk arrives, so buffering the whole reply adds
      // its entire generation time to the silence the other person hears
      // after they stop talking.
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      const writer = new SseChunkWriter((line) => res.write(line), request.model ?? "vance-pi");
      try {
        const completion = await completeWithPi(request, (delta) => writer.text(delta));
        captureLlmConversation(request, completion);
        writer.close(completion.toolCalls);
      } catch (error) {
        // The response is already open with a 200, so there is no status code
        // left to fail with. Close the stream cleanly and let Vapi carry on —
        // a silent turn is recoverable, a hung socket is not.
        console.error("stream failed:", error);
        writer.close([]);
      }
      res.end();
      return;
    }

    if (req.method === "POST" && pathname === "/vapi/events") {
      if (!bearerMatches(req, process.env.WEBHOOK_SECRET)) return json(res, 401, { error: "Unauthorized" });
      const payload = await readBody(req) as any;
      handleVapiEvent(payload);
      console.log(JSON.stringify({
        event: payload.message?.type,
        callId: payload.message?.call?.id,
        endedReason: payload.message?.endedReason,
      }));
      return json(res, 200, {});
    }

    if (req.method === "GET" && ["/", "/index.html", "/styles.css", "/app.js"].includes(pathname)) {
      await serveStatic(pathname, res);
      return;
    }

    return json(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    const message = error instanceof Error ? error.message : "Something went wrong.";
    const status = message.startsWith("Enter a phone") || message.startsWith("Use a valid phone") ? 400 : 500;
    return json(res, status, { error: message });
  }
});

const port = Number(process.env.PORT ?? 8787);
server.listen(port, () => console.log(`Vance: Vapi transport -> Pi brain on port ${port}`));
