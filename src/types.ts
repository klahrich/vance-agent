export interface OpenAiTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface OpenAiChatRequest {
  model?: string;
  messages?: OpenAiMessage[];
  tools?: OpenAiTool[];
  stream?: boolean;
  temperature?: number;
  call?: {
    id?: string;
    status?: string;
    createdAt?: string;
    startedAt?: string;
    endedAt?: string;
    customer?: { number?: string };
    monitor?: { listenUrl?: string; controlUrl?: string };
  };
}

export interface PiCompletion {
  id: string;
  model: string;
  text: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
}
