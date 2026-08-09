import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { TSchema } from "typebox";
import type { OpenAiChatRequest, OpenAiMessage, PiCompletion } from "./types.js";

const PI_MODEL = process.env.PI_MODEL ?? "gpt-5.6-terra";
const PI_THINKING_LEVEL = process.env.PI_THINKING_LEVEL ?? "medium";
const PI_SERVICE_TIER = process.env.PI_SERVICE_TIER ?? "priority";

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

export async function completeWithPi(request: OpenAiChatRequest): Promise<PiCompletion> {
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
    }),
    beforeToolCall: async () => ({
      block: true,
      reason: "Forward this tool call to Vapi for execution.",
      terminate: true,
    }),
  });

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

export function openAiSse(completion: PiCompletion): string {
  const base = { id: completion.id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: completion.model };
  const chunks: Record<string, unknown>[] = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
  ];
  if (completion.text) {
    chunks.push({ ...base, choices: [{ index: 0, delta: { content: completion.text }, finish_reason: null }] });
  }
  completion.toolCalls.forEach((call, index) => {
    chunks.push({
      ...base,
      choices: [{
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
      }],
    });
  });
  chunks.push({
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: completion.toolCalls.length ? "tool_calls" : "stop" }],
  });
  return `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}
