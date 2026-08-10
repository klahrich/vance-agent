import { describe, expect, it } from "vitest";
import { SseChunkWriter, openAiCompletion } from "../src/pi-llm.js";
import { listMissions, loadMission } from "../src/missions/loader.js";
import { composeSystemPrompt } from "../src/prompt/compose.js";
import { CORE_PROMPT } from "../src/prompt/core.js";
import { conductPlan } from "../src/vapi/conduct.js";

const completion = {
  id: "chatcmpl-test",
  model: "vance-pi",
  text: "",
  toolCalls: [{ id: "call-1", name: "dtmf", arguments: { digits: "123#" } }],
};

describe("Pi custom LLM bridge", () => {
  it("returns Pi tool calls in OpenAI format for Vapi", () => {
    const response = openAiCompletion(completion) as any;
    expect(response.choices[0].message.tool_calls[0].function).toEqual({
      name: "dtmf",
      arguments: '{"digits":"123#"}',
    });
    expect(response.choices[0].finish_reason).toBe("tool_calls");
  });

  it("streams text as it arrives, then closes with tool calls and DONE", () => {
    const lines: string[] = [];
    const writer = new SseChunkWriter((line) => lines.push(line), "vance-pi");
    writer.text("Hey, ");
    writer.text("it's Vance.");
    writer.close(completion.toolCalls);

    const body = lines.join("");
    // The role chunk must precede any content, and must be emitted exactly
    // once however many deltas arrive.
    expect(lines[0]).toContain('"role":"assistant"');
    expect(body.match(/"role":"assistant"/g)).toHaveLength(1);
    expect(body).toContain('"content":"Hey, "');
    expect(body).toContain('"content":"it\'s Vance."');
    expect(body).toContain('"name":"dtmf"');
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("still opens the stream when the turn produced no text", () => {
    const lines: string[] = [];
    new SseChunkWriter((line) => lines.push(line), "vance-pi").close([]);
    expect(lines[0]).toContain('"role":"assistant"');
    expect(lines.join("")).toContain('"finish_reason":"stop"');
  });
});

describe("missions", () => {
  it("loads every mission on disk without error", async () => {
    const missions = await listMissions();
    expect(missions.length).toBeGreaterThan(0);
    for (const mission of missions) expect(mission.error).toBeUndefined();
  });

  it("parses frontmatter and keeps the body as prose", async () => {
    const mission = await loadMission("line-check");
    expect(mission.conduct).toBe("listening");
    expect(mission.opens).toBe("vance");
    expect(mission.firstMessage).toBeTruthy();
    expect(mission.tools).toContain("endCall");
    expect(mission.body).toContain("test call");
    // Frontmatter must not leak into what the model reads.
    expect(mission.body).not.toContain("conduct:");
  });

  it("refuses names that could escape the missions directory", async () => {
    await expect(loadMission("../../etc/passwd")).rejects.toThrow(/invalid mission name/);
  });

  it("refuses a mission that cannot hang up", async () => {
    // A call with no endCall tool can only be ended by the far end, and bills
    // by the minute until then.
    await expect(loadMission("nonexistent-mission")).rejects.toThrow(/no such mission/);
  });
});

describe("prompt composition", () => {
  it("layers CORE, the mission body, and the caller's context", async () => {
    const mission = await loadMission("bell-retention");
    const prompt = composeSystemPrompt(mission, "My account number is 12345.");
    expect(prompt.startsWith(CORE_PROMPT)).toBe(true);
    expect(prompt).toContain(mission.body);
    expect(prompt).toContain("My account number is 12345.");
  });

  it("says so explicitly when there is no context", async () => {
    const mission = await loadMission("line-check");
    expect(composeSystemPrompt(mission, "   ")).toContain("no additional background");
  });

  it("keeps mission-specific wording out of CORE", () => {
    // CORE is the reusable half; the moment an errand leaks into it, every
    // future mission inherits the wrong instructions.
    expect(CORE_PROMPT).not.toMatch(/bell|telecom|scoping|bill/i);
  });
});

describe("conduct presets", () => {
  it("gives a listening call materially more room before speaking", () => {
    const leading = conductPlan("leading").startSpeakingPlan as { waitSeconds: number };
    const listening = conductPlan("listening").startSpeakingPlan as { waitSeconds: number };
    expect(listening.waitSeconds).toBeGreaterThan(leading.waitSeconds * 4);
  });

  it("never counts a backchannel as an interruption", () => {
    for (const conduct of ["leading", "listening"] as const) {
      const stop = conductPlan(conduct).stopSpeakingPlan as { acknowledgementPhrases: string[] };
      expect(stop.acknowledgementPhrases).toContain("mm-hmm");
    }
  });
});
