import { describe, expect, it } from "vitest";
import { openAiCompletion, openAiSse } from "../src/pi-llm.js";
import { VANCE_SYSTEM_PROMPT } from "../src/vapi-prompt.js";

const completion = {
  id: "chatcmpl-test",
  model: "vance-pi",
  text: "",
  toolCalls: [{ id: "call-1", name: "dtmf", arguments: { digits: "123#" } }],
};

describe("Pi custom LLM bridge", () => {
  it("keeps the profile as one raw variable", () => {
    expect(VANCE_SYSTEM_PROMPT).toContain("{{profile_text}}");
    expect(VANCE_SYSTEM_PROMPT).not.toContain("{{account_number}}");
  });

  it("returns Pi tool calls in OpenAI format for Vapi", () => {
    const response = openAiCompletion(completion) as any;
    expect(response.choices[0].message.tool_calls[0].function).toEqual({ name: "dtmf", arguments: '{"digits":"123#"}' });
    expect(response.choices[0].finish_reason).toBe("tool_calls");
  });

  it("terminates streaming responses with DONE", () => {
    const response = openAiSse(completion);
    expect(response).toContain('"name":"dtmf"');
    expect(response.endsWith("data: [DONE]\n\n")).toBe(true);
  });
});
