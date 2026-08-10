/** How the call should be paced. Two presets rather than raw numbers, because
 *  the raw numbers are invisible in review and one of them decides whether the
 *  agent talks over people. See src/vapi/conduct.ts. */
export type Conduct = "leading" | "listening";

/** Who speaks first when the call connects. */
export type Opens = "vance" | "them";

export interface Mission {
  /** File stem; what you pass to the CLI and the dashboard. */
  name: string;
  /** One line, shown in the dashboard mission picker. */
  description: string;
  /** What to call the other side in transcripts, e.g. "rep", "client". */
  counterpart: string;
  conduct: Conduct;
  opens: Opens;
  /** Spoken when `opens` is "vance". Required in that case. */
  firstMessage?: string;
  /** Vapi default tools this mission may use, e.g. ["endCall", "dtmf"]. */
  tools: string[];
  maxMinutes: number;
  /** Overrides VAPI_VOICE_ID for this mission. */
  voice?: string;
  /** Path (relative to the mission file) of a JSON Schema for structured
   *  extraction at end of call. Wired in phase 2. */
  outcome?: string;
  /** The prose half: goal, conduct, boundaries. Goes into the system prompt
   *  verbatim, after CORE. */
  body: string;
}
