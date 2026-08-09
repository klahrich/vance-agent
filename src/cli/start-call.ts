import "dotenv/config";
import { readFile } from "node:fs/promises";
import { loadProfileText } from "../config.js";
import { startVapiCall } from "../vapi-api.js";

const profileId = process.argv[2];
if (!profileId) throw new Error("Usage: npm run call -- <profile-id>");
const assistantId = process.env.VAPI_ASSISTANT_ID ?? (
  JSON.parse(await readFile(".vapi-resources.json", "utf8")) as { assistantId: string }
).assistantId;
const profileText = await loadProfileText(profileId);
const call = await startVapiCall(profileId, profileText, assistantId);
console.log(`Started Vapi call ${call.id}${call.status ? ` (${call.status})` : ""}.`);
if (call.monitor?.listenUrl) console.log(`Listen-only monitor: ${call.monitor.listenUrl}`);
