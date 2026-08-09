import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { provisionVapi } from "../vapi-api.js";

const resources = await provisionVapi();
await writeFile(".vapi-resources.json", `${JSON.stringify(resources, null, 2)}\n`, { mode: 0o600 });
console.log(`Created Vapi assistant ${resources.assistantId} backed directly by Pi.`);
