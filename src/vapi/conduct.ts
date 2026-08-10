// Turn-taking presets.
//
// These are the numbers that decide whether Vance feels attentive or feels
// like a robot, and they are invisible in a code review. `waitSeconds` is the
// worst offender: at 0.15 the agent starts talking 150ms after the other
// person stops making noise. Against a rep working from a script that reads as
// snappy. Against someone thinking out loud, it interrupts every time they
// pause mid-sentence — and once that happens twice, people stop trying to
// explain things properly, which is fatal for any call whose purpose is to
// learn something.
//
// So a mission picks a named intent and inherits a tuned set, rather than
// inheriting whatever the last mission happened to need.
import type { Conduct } from "../missions/types.js";

/** Backchannel noises that must not count as an interruption. */
const ACKNOWLEDGEMENTS = [
  "okay",
  "right",
  "yeah",
  "yes",
  "uh-huh",
  "mm-hmm",
  "got it",
  "sure",
  "alright",
];

export interface ConductPlan {
  startSpeakingPlan: Record<string, unknown>;
  stopSpeakingPlan: Record<string, unknown>;
}

const PLANS: Record<Conduct, ConductPlan> = {
  // Vance drives: phone trees, hold queues, a rep working from a script.
  // Responsiveness matters more than patience.
  leading: {
    startSpeakingPlan: {
      waitSeconds: 0.15,
      smartEndpointingPlan: { provider: "vapi" },
    },
    stopSpeakingPlan: {
      numWords: 2,
      voiceSeconds: 0.2,
      backoffSeconds: 0.8,
      acknowledgementPhrases: ACKNOWLEDGEMENTS,
    },
  },

  // The other person does most of the talking and needs room to think.
  // Waiting through a pause costs a second; cutting them off costs the answer.
  listening: {
    startSpeakingPlan: {
      waitSeconds: 1.2,
      smartEndpointingPlan: { provider: "vapi" },
    },
    stopSpeakingPlan: {
      numWords: 1,
      voiceSeconds: 0.15,
      backoffSeconds: 1.5,
      acknowledgementPhrases: ACKNOWLEDGEMENTS,
    },
  },
};

export function conductPlan(conduct: Conduct): ConductPlan {
  return PLANS[conduct];
}
