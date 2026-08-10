// system prompt = CORE + mission body + context
//
// Three layers, composed here and nowhere else. CORE is call craft and never
// varies. The mission body is the errand. Context is the caller's raw notes,
// supplied per call and never committed — account numbers for one mission, a
// client brief for another. It has no schema on purpose: the model reads it as
// ordinary language, which is a better fit for nuance like "he'll probably
// push for a fixed price, don't take the bait" than any field could be.
import type { Mission } from "../missions/types.js";
import { CORE_PROMPT } from "./core.js";

export function composeSystemPrompt(mission: Mission, contextText: string): string {
  const context = contextText.trim();
  return [
    CORE_PROMPT,
    `THIS CALL: ${mission.description.toUpperCase()}`,
    mission.body,
    context
      ? [
          "WHAT YOU KNOW GOING IN",
          "",
          "The person you are calling for wrote the following in their own words.",
          "Read it as ordinary language; there is no format and no required",
          "fields. Use their instructions and your judgment together.",
          "",
          context,
        ].join("\n")
      : "You were given no additional background for this call. Work from the mission above.",
  ].join("\n\n---\n\n");
}
