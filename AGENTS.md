# AGENTS.md — vance-agent

Guidance for AI agents working in this repo. Every rule here comes from a
real incident, not a style preference. Read [HANDOFF.md](HANDOFF.md) for
where things currently stand, and [learnings/](learnings/README.md) before
optimising anything.

## What this is

Vance places phone calls on someone's behalf. What it does on a given
call comes from a **mission file**; nothing in the code knows about any
specific errand.

```
      phone call
          ↕
Vapi — audio, transcript, voice, DTMF, live call control
          ↕
this service — OpenAI-compatible custom-LLM endpoint + web call room
          ↕
Pi agent — one stateless turn of reasoning
```

## Repo shape

- `src/prompt/core.ts` — CORE: how to behave on any call. The asset.
- `src/prompt/compose.ts` — CORE + mission body + context, composed here
  and nowhere else.
- `missions/*.md` — one file per errand. Frontmatter for the handful of
  things code branches on; prose for everything else.
- `contexts/*.txt` — per-call background. **Gitignored.**
- `src/missions/`, `src/vapi/conduct.ts`, `src/vapi-api.ts`, `src/pi-llm.ts`,
  `src/server.ts`, `public/` (the call room).
- `stories/` — design and phasing. `learnings/` — dated, what was learned
  the expensive way.

Verify with `npm run typecheck` and `npm test` before every commit.

## The prompt

- **CORE is universal and must never be forked.** It is turn-taking, IVR
  and hold handling, when to end a call, how not to sound like a robot —
  learned by making real calls. A mission that restates any of it is a
  bug. A mission-specific phrase that leaks *into* CORE is a worse one;
  there is a test asserting CORE mentions no specific errand.
- **Prose by default, structure only where an `if` reads it.** An earlier
  design modelled the agent's authority as typed tiers with bounds. It was
  over-engineering: real instructions carry nuance like *"he'll probably
  push for a fixed price, don't take the bait"* that no field expresses.
- **Everything the model writes is spoken aloud.** Write names the way
  they should sound ("Kareem", not "Karim"), and never emit lists,
  headings or markdown.
- **The single-space rule**: replying with exactly `" "` keeps Vance
  silent. That is how it survives IVR menus and hold music. Do not
  "clean it up".

## Missions

- `conduct: leading | listening` is the most consequential field.
  `leading` starts speaking 150ms after the other person stops;
  `listening` waits 1.2s. Use `listening` for anything where the other
  person does the talking — interrupting someone twice makes them stop
  explaining things, which is fatal on a call meant to learn something.
  **Never hand-tune the raw numbers in a mission**; add a preset.
- `tools` must include `endCall`, enforced by the loader. Without it a
  stuck call bills by the minute.
- Assistants are **built per call** (`buildAssistant`), never provisioned.
  A provisioned assistant drifts from the file the moment someone skips a
  sync step.

## Context

- **Contexts are gitignored, so they are not in the deployed image
  either.** A context that works locally is silently empty in production:
  the agent still calls, still sounds competent, and knows nothing. This
  happened, and the only evidence was the transcript afterwards.
- On a deployed service, context arrives as `CONTEXT_<MISSION>` (uppercase,
  dashes to underscores). Editing `contexts/x.txt` locally changes nothing
  in production until that variable is updated.
- The dashboard states which source a call will use, and warns when there
  is none. Keep that warning working.

## Latency

- **`PI_REASONING_EFFORT=none`.** This is 2.6× — larger than every other
  lever combined. Reasoning tokens are generated before any text exists
  and cannot be streamed, so they land entirely in the silence after the
  other person stops talking.
- Pi talks to the **Responses API**: the field is `reasoning.effort`, not
  the chat-completions `reasoning_effort`. Get it wrong and every turn
  400s — but the SSE stream is already open with a 200, so the symptom is
  **Vance silently never speaking for the whole call**, not an error.
  When the agent goes mute, suspect the model request first.
- Stream tokens as they are produced. It saves ~18ms on a median turn and
  up to 9 seconds on a long one; it is variance insurance, not speed.
  Do not remove it after looking at the median.
- **Measure warm.** Cold requests run 2–3× slower and will send you
  chasing the wrong thing. Discard the first two or three.
- Do not compress or summarise the transcript to go faster: prompt size
  does not affect latency, and an agent that has forgotten minute 9 will
  re-ask it at minute 38.

## Outcomes

- **Own the extraction.** Vapi's `analysisPlan` works on short calls and
  came back empty — no error, no partial object — on a 24-minute one. The
  transcript is the durable artifact; structured output is a derivation
  that must be re-runnable (`npm run extract -- <call-id>`).
- Outcome schemas have **no required fields**, so an absent field means
  "not discussed". Be aware that this makes a total extraction failure
  look identical to a call that covered nothing.
- The extraction prompt must keep saying *do not infer, a question is not
  an answer*. An invented field is worse than a missing one because it
  gets acted on.

## Transcripts

Vapi runs STT over **Vance's own audio too**, so its artifact is a
text → speech → text round trip ("Karim" came back as "Cream"). Prefer
our own copy of what was said; only the other party's side should come
from transcription.

## Deployment (Railway)

- **No Docker.** Builder is Railpack, pinned in `railway.json`. A stale
  `dockerfilePath` on the service once broke every build for 45 minutes.
- Deploys happen on **push to `main`**. `railway up` has been unreliable
  here; prefer pushing.
- `PUBLIC_BASE_URL` must point at the live domain before any call — it is
  how Vapi reaches the reasoning endpoint. Pointing it at the wrong host
  sends your call transcripts to someone else's server.
- Deleting a service from the dashboard only removes it **from that
  environment**; it comes back. Use `serviceDelete` with no
  `environmentId`.
- Two services sharing one GitHub trigger both deploy on every push.
- Region matters: every turn is Vapi → Railway → OpenAI → back.

## Testing and operations

- **Passing tests are not evidence that a call works.** Every real
  failure so far — a rejected model request, a builder that would not
  build, an empty context, turn-taking tuned wrong — was invisible to
  `npm test` and `tsc`.
- `npm run call -- <mission> [number] [context-id]` places a call.
  `line-check` is a two-minute self-test that exercises audio, read-back
  and deliberate interruption.
- Rehearse against your own phone before any call that matters. There is
  no dry run for a phone call.
- Debug with `railway logs`, and `railway logs --build <deployment-id>` —
  the unqualified build command shows a stale successful build.

## House rules

- Never commit `.env`, `contexts/*.txt`, or anything in `out/`. Rotate any
  credential that lands in git.
- Update `stories/` when the design changes; add a dated file to
  `learnings/` when something is learned the expensive way, including
  wrong predictions.
- Developed on Windows: beware CRLF when patching files with scripts.
  Several silent no-op patches came from this — prefer an editing tool
  over `sed`.
- Concise commits, imperative mood, what and why.
