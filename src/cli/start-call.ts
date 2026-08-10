// Usage: npm run call -- <mission> [destination] [context-id]
//
//   npm run call -- line-check
//   npm run call -- bell-retention +14165550100 my-bell-account
//
// Destination falls back to DEFAULT_DESTINATION; context to a file in
// contexts/ named after the mission, then to VANCE_CONTEXT_TEXT, then to none.
import "dotenv/config";
import { loadContextText } from "../config.js";
import { loadMission } from "../missions/loader.js";
import { createVapiCall } from "../vapi-api.js";

const [missionName, destinationArg, contextArg] = process.argv.slice(2);
if (!missionName) {
  console.error("Usage: npm run call -- <mission> [destination] [context-id]");
  process.exit(1);
}

const mission = await loadMission(missionName);

const destination = destinationArg ?? process.env.DEFAULT_DESTINATION;
if (!destination) {
  console.error("No destination given and DEFAULT_DESTINATION is not set.");
  process.exit(1);
}

const contextText = await loadContextText(contextArg ?? missionName).catch(() =>
  process.env.VANCE_CONTEXT_TEXT ?? "",
);

const call = await createVapiCall(mission, destination, contextText);
console.log(`Mission "${mission.name}" (${mission.conduct}) → ${destination}`);
console.log(`Context: ${contextText ? `${contextText.length} chars` : "none"}`);
console.log(`Call ${call.id}${call.status ? ` (${call.status})` : ""}.`);
if (call.monitor?.listenUrl) console.log(`Listen-only monitor: ${call.monitor.listenUrl}`);
