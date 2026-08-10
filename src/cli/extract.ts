// Re-extract the deliverable from a past call.
//
//   npm run extract -- <vapi-call-id>
//   npm run extract -- latest
//
// Needs no database: the transcript lives in Vapi, and the schema lives in the
// mission file, so any call ever placed can be re-read. That property is the
// point — when Vapi's own extraction came back empty on a 24-minute scoping
// call, this is what turned a lost deliverable into a two-minute rerun.
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { env } from "../config.js";
import { extractOutcome } from "../extract.js";
import { getVapiCall, type VapiCall } from "../vapi-api.js";

async function latestCallId(): Promise<string> {
  const response = await fetch("https://api.vapi.ai/call?limit=1", {
    headers: { Authorization: `Bearer ${env("VAPI_API_KEY")}` },
  });
  if (!response.ok) throw new Error(`Vapi ${response.status}: ${await response.text()}`);
  const calls = (await response.json()) as VapiCall[];
  const id = calls[0]?.id;
  if (!id) throw new Error("No calls found.");
  return id;
}

const arg = process.argv[2];
if (!arg) {
  console.error("Usage: npm run extract -- <vapi-call-id>|latest");
  process.exit(1);
}

const callId = arg === "latest" ? await latestCallId() : arg;
const call = await getVapiCall(callId);
const mission = (call.metadata?.mission as string | undefined) ?? process.argv[3];
if (!mission) {
  console.error(`Call ${callId} has no mission in its metadata. Pass one as the second argument.`);
  process.exit(1);
}

const messages = call.artifact?.messages ?? call.messages ?? [];
console.error(`call ${callId} · mission ${mission} · ${messages.length} turns`);

const structured = await extractOutcome(mission, messages);
if (!structured) {
  console.error("Nothing extracted — the mission has no outcome schema, or the transcript is too short.");
  process.exit(1);
}

await mkdir(resolve(process.cwd(), "out"), { recursive: true });
const path = resolve(process.cwd(), "out", `${mission}-${callId.slice(0, 8)}.json`);
await writeFile(path, `${JSON.stringify(structured, null, 2)}\n`);
console.error(`written: ${path}`);
// stdout stays clean so this can be piped.
console.log(JSON.stringify(structured, null, 2));
