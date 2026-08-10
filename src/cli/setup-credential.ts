// One-time setup. Creates the credential Vapi uses to authenticate against our
// custom-LLM endpoint, and prints the id to put in .env.
//
// This is all that is left of provisioning: assistants are now built per call
// from a mission file, so there is no resource to keep in sync and nothing
// written to disk.
import "dotenv/config";
import { provisionCustomLlmCredential } from "../vapi-api.js";

const existing = process.env.VAPI_CUSTOM_LLM_CREDENTIAL_ID;
if (existing) {
  console.log(`VAPI_CUSTOM_LLM_CREDENTIAL_ID is already set (${existing}).`);
  console.log("Unset it first if you really want to create another credential.");
  process.exit(0);
}

const id = await provisionCustomLlmCredential();
console.log("Created the custom-LLM credential. Add this to .env and Railway:\n");
console.log(`VAPI_CUSTOM_LLM_CREDENTIAL_ID=${id}`);
