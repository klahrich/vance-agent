// Extracting the deliverable from a transcript, ourselves.
//
// Vapi can do this via analysisPlan, and for short calls it does. On a
// 24-minute scoping call it silently returned a summary and no structured
// data at all — no error, no partial result, just an absent field. The
// deliverable was recoverable only because the transcript survived.
//
// So the transcript is treated as the durable artifact and extraction as
// something we own and can re-run. Vapi's analysis is kept as the fast path
// because it is free and usually works; this is the fallback the reconciler
// reaches for when it did not.
import { loadMission } from "./missions/loader.js";
import type { VapiCallMessage } from "./vapi-api.js";

const MODEL = process.env.EXTRACT_MODEL ?? process.env.PI_MODEL ?? "gpt-5.5";
// Unlike a conversational turn, nobody is waiting on the line for this, so
// reasoning is worth paying for here — it is reading a long transcript and
// deciding what was genuinely said versus merely asked about.
const EFFORT = process.env.EXTRACT_REASONING_EFFORT ?? "medium";

export function transcriptToText(messages: VapiCallMessage[], counterpart = "CLIENT"): string {
  return messages
    .filter((m) => ["user", "bot", "assistant"].includes(m.role ?? ""))
    .map((m) => {
      const who = m.role === "user" ? counterpart.toUpperCase() : "VANCE";
      return `${who}: ${(m.message ?? m.content ?? "").trim()}`;
    })
    .filter((line) => line.split(": ")[1])
    .join("\n");
}

function buildPrompt(
  description: string,
  counterpart: string,
  schema: Record<string, unknown>,
  transcript: string,
): string {
  const other = counterpart.toUpperCase();
  return [
    `You are reading the transcript of a call whose purpose was: ${description}.`,
    "Extract what was actually said into the JSON schema below.",
    "",
    `Record only what ${other} stated or clearly implied. If a field was never`,
    "discussed, omit it. Do not infer it, do not fill it with something",
    "plausible, and do not carry over an assumption from Vance's own questions —",
    "a question is not an answer. A missing field is a useful signal that the",
    "call did not cover it; an invented one is worse than nothing, because it",
    "will be acted on.",
    "",
    `Quote or closely paraphrase ${other}'s own words where the schema asks for`,
    "a description rather than a category.",
    "",
    "SCHEMA:",
    JSON.stringify(schema, null, 2),
    "",
    "TRANSCRIPT:",
    transcript,
    "",
    "Return only the JSON object.",
  ].join("\n");
}

/**
 * Returns the extracted object, or null when this mission has no outcome
 * schema or the transcript is too thin to be worth reading.
 */
export async function extractOutcome(
  missionName: string,
  messages: VapiCallMessage[],
): Promise<Record<string, unknown> | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const mission = await loadMission(missionName).catch(() => null);
  if (!mission?.outcomeSchema) return null;

  const transcript = transcriptToText(messages, mission.counterpart);
  if (transcript.length < 200) return null;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      reasoning_effort: EFFORT,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "user",
          content: buildPrompt(
            mission.description,
            mission.counterpart,
            mission.outcomeSchema,
            transcript,
          ),
        },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`extraction failed (${response.status}): ${(await response.text()).slice(0, 200)}`);
  }
  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (!content) return null;
  return JSON.parse(content) as Record<string, unknown>;
}
