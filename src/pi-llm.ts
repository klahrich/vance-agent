import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { TSchema } from "typebox";
import type { OpenAiChatRequest, OpenAiMessage, PiCompletion } from "./types.js";

const PI_MODEL = process.env.PI_MODEL ?? "gpt-5.5";
const PI_THINKING_LEVEL = process.env.PI_THINKING_LEVEL ?? "low";
const PI_SERVICE_TIER = process.env.PI_SERVICE_TIER ?? "priority";

/**
 * Reasoning effort, overriding whatever Pi derives from `thinkingLevel`.
 *
 * This is the single biggest latency lever in the system, by a wide margin.
 * Measured on gpt-5.5 with a 2k-token prompt: `low` gives ~2.3s to first
 * token, `none` gives ~0.59s. Every reasoning token is generated before any
 * text exists, so it lands squarely in the silence after the other person
 * stops speaking — and unlike text, it cannot be streamed.
 *
 * `none` is the default because a phone conversation is mostly reflex: ask
 * the obvious follow-up, acknowledge, keep the thread. Raise it per
 * deployment if a mission genuinely needs deliberation and can afford the
 * pause. Pi's own thinkingLevel type has no "off", which is why this goes
 * through the payload hook instead.
 */
const PI_REASONING_EFFORT = process.env.PI_REASONING_EFFORT ?? "none";

function renderMessage(message: OpenAiMessage): string {
  if (message.role === "assistant" && message.tool_calls?.length) {
    return `ASSISTANT TOOL CALLS: ${JSON.stringify(message.tool_calls)}`;
  }
  if (message.role === "tool") {
    return `TOOL RESULT (${message.name ?? message.tool_call_id ?? "unknown"}): ${message.content ?? ""}`;
  }
  return `${message.role.toUpperCase()}: ${message.content ?? ""}`;
}

function createForwardedTools(request: OpenAiChatRequest): AgentTool[] {
  return (request.tools ?? []).map((tool) => ({
    name: tool.function.name,
    label: tool.function.name,
    description: tool.function.description ?? `Call ${tool.function.name}`,
    parameters: (tool.function.parameters ?? { type: "object", properties: {} }) as unknown as TSchema,
    execute: async () => ({
      content: [{ type: "text", text: "This tool is executed by Vapi." }],
      details: {},
      terminate: true,
    }),
  }));
}

/** Called with each text fragment as the model produces it. */
export type DeltaSink = (delta: string) => void;

/**
 * One turn of reasoning, stateless.
 *
 * Vapi owns the conversation: it hands us the whole transcript every turn and
 * we build a fresh agent from it. Nothing is persisted here, which is what
 * lets the service restart mid-call without anyone noticing, and what keeps a
 * database out of the audio latency path.
 *
 * `onDelta` receives text as it is generated so the caller can forward it
 * straight to Vapi. Emitting incrementally is not an optimisation: until the
 * first token reaches Vapi, no audio can start, and that dead air is most of
 * the gap the other person hears after they stop speaking.
 */
export async function completeWithPi(
  request: OpenAiChatRequest,
  onDelta?: DeltaSink,
): Promise<PiCompletion> {
  const messages = request.messages ?? [];
  const systemPrompt = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content ?? "")
    .join("\n\n");
  const transcript = messages
    .filter((message) => message.role !== "system")
    .map(renderMessage)
    .join("\n\n");

  const models = createModels();
  models.setProvider(openaiProvider());
  const model = models.getModel("openai", PI_MODEL);
  if (!model) throw new Error(`Pi model not found: openai/${PI_MODEL}`);

  const tools = createForwardedTools(request);
  const agent = new Agent({
    initialState: {
      systemPrompt: [
        systemPrompt,
        "You are the sole intelligence controlling this call. Vapi only transports audio and executes tools.",
        "Respond naturally to the latest turn. When a supplied tool is needed, call it instead of describing the action.",
      ].filter(Boolean).join("\n\n"),
      model,
      tools,
      thinkingLevel: PI_THINKING_LEVEL as "medium",
    },
    streamFn: models.streamSimple.bind(models),
    onPayload: (payload) => ({
      ...(payload as Record<string, unknown>),
      service_tier: PI_SERVICE_TIER,
      ...(PI_REASONING_EFFORT === "inherit" ? {} : { reasoning_effort: PI_REASONING_EFFORT }),
    }),
    beforeToolCall: async () => ({
      block: true,
      reason: "Forward this tool call to Vapi for execution.",
      terminate: true,
    }),
  });

  if (onDelta) {
    agent.subscribe((event) => {
      if (event.type !== "message_update") return;
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta" && update.delta) onDelta(update.delta);
    });
  }

  await agent.prompt([
    "Here is the complete call transcript supplied by Vapi. Continue from the final turn.",
    transcript || "The call has just started. Begin according to your instructions.",
  ].join("\n\n"));

  const assistant = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
  if (!assistant || assistant.role !== "assistant") throw new Error("Pi produced no assistant response");
  if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
    throw new Error(assistant.errorMessage ?? `Pi completion ${assistant.stopReason}`);
  }
  const text = assistant.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  const toolCalls = assistant.content
    .filter((block) => block.type === "toolCall")
    .map((block) => ({ id: block.id, name: block.name, arguments: block.arguments }));

  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    model: request.model ?? "vance-pi",
    text,
    toolCalls,
  };
}

export function openAiCompletion(completion: PiCompletion): Record<string, unknown> {
  return {
    id: completion.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: completion.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: completion.text || null,
        ...(completion.toolCalls.length ? {
          tool_calls: completion.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          })),
        } : {}),
      },
      finish_reason: completion.toolCalls.length ? "tool_calls" : "stop",
    }],
  };
}

/** Incremental SSE writer for the OpenAI chat-completions chunk format. */
export class SseChunkWriter {
  private readonly base: { id: string; object: string; created: number; model: string };
  private opened = false;

  constructor(
    private readonly write: (line: string) => void,
    model: string,
    id = `chatcmpl-${crypto.randomUUID()}`,
  ) {
    this.base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
  }

  private emit(choice: Record<string, unknown>): void {
    this.write(`data: ${JSON.stringify({ ...this.base, choices: [choice] })}\n\n`);
  }

  /** Vapi will not start synthesising until it sees a chunk, so open the
   *  stream before the model has produced anything. */
  open(): void {
    if (this.opened) return;
    this.opened = true;
    this.emit({ index: 0, delta: { role: "assistant" }, finish_reason: null });
  }

  text(delta: string): void {
    this.open();
    this.emit({ index: 0, delta: { content: delta }, finish_reason: null });
  }

  /** Tool calls are only known once the turn completes: `beforeToolCall`
   *  blocks execution so Vapi can run them, which means they surface at the
   *  end rather than streaming. */
  close(toolCalls: PiCompletion["toolCalls"]): void {
    this.open();
    toolCalls.forEach((call, index) => {
      this.emit({
        index: 0,
        delta: {
          tool_calls: [{
            index,
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.arguments) },
          }],
        },
        finish_reason: null,
      });
    });
    this.emit({ index: 0, delta: {}, finish_reason: toolCalls.length ? "tool_calls" : "stop" });
    this.write("data: [DONE]\n\n");
  }
}
