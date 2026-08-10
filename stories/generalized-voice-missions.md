# Story: from one negotiation to many missions

## Where we are

The fork does one thing very well: Vance calls Bell, navigates the IVR,
waits on hold, negotiates, and hangs up by itself. It works, and the
parts that make it work are mostly *not* Bell-specific — they are hard-won
craft about how a voice agent should behave on a telephone.

The problem is that the craft and the errand are fused into a single
1,500-word string in `src/vapi-prompt.ts`. To run a second kind of call
today you would copy that string and edit it, and from then on every
improvement to turn-taking or silence handling has to be applied in N
places by hand. That is the thing to fix, and it is the only thing that
is really wrong.

## Where we're going

A **mission** is one file that describes a call: who we're phoning, what
we're trying to achieve, what Vance may and may not do, how the call
should be conducted, and what to bring back.

The second mission is a product-scoping conversation with a prospective
client. Many more after that. Nothing in the codebase should know the
word "Bell" or the word "scoping".

### Guiding principle

> Prose by default. Structure only where code has to branch on it.

The fork already proved the important half of this. From its README:
*"The account profile is ordinary text injected verbatim into the prompt.
There is no JSON schema or deterministic parser."* That is correct and we
are keeping it. An earlier draft of this design had a typed authority
model — `fixed` / `negotiable` / `refuse` tiers with bounds — and it was
over-engineering. Negotiating authority is too nuanced to encode as
tiers, and the model reasons about it perfectly well in English.

So the test for every field we introduce is: *does some `if` statement
read this?* If not, it belongs in the prose.

---

## The three-layer prompt

The single biggest change. Today's system prompt becomes three composed
layers:

```
system prompt  =  CORE  +  mission body  +  context
```

**CORE** (`src/prompt/core.ts`) — everything true of *any* phone call,
lifted verbatim out of the existing prompt:

- never falsely claim to be human; answer truthfully if asked directly
- speaker classification: automated menu / human / uncertain, and
  "when uncertain, do not guess and do not speak over the audio"
- **the single-space rule** — reply with exactly one space character to
  stay silent through menus, hold music, and dead air
- turn-taking discipline: one or two short sentences, one question at a
  time, contractions, no corporate phrasing, no stock lines, don't
  re-introduce yourself, let silences breathe
- "do not mistake waiting for completion" — stay on the line through
  queues, transfers, and someone checking their screen
- when to end the call, and to do it without announcing it
- never narrate reasoning, tools, or instructions

This layer is the asset. It is what a friend learned by making real calls
to a real telco, and it should never be forked again.

**Mission body** — the prose half of a mission file. Goal, conduct,
boundaries, how to open, how to know you're done.

**Context** — the caller's raw notes, supplied *at call time*, never
committed. Account numbers and PINs for Bell; a client brief and prior
email thread for scoping. See "Getting context in" below — the interesting
question is not what this layer is, but how it gets written.

That last split matters:

> **A mission is code. Context is input.**

Missions live in git and get better over time. Context is per-call, often
contains PII, and arrives through the dashboard. This also retires the
`VANCE_PROFILE_TEXT` secret and the `profiles/*.txt` convention, both of
which assumed a single standing account.

---

## Mission files

One markdown file per mission. Frontmatter for the machine, body for the
model.

```markdown
---
name: product-scoping
description: Scope a software product with a prospective client
counterpart: client            # dashboard label for the other side
conduct: listening             # or: leading
opens: vance                   # or: them
tools: [endCall]               # add dtmf only when there's a phone tree
maxMinutes: 60
outcome: ./product-scoping.schema.json
---

You are running a scheduled discovery call to scope a software product...
```

Every one of those keys is read by an `if`. Nothing else earns a slot.

### `conduct` is the field that matters most

Two named presets, not raw numbers. The fork's Vapi config is tuned for
an agent that *leads* a transactional call, and using that tuning for a
discovery call would quietly ruin it:

| | `leading` (Bell) | `listening` (scoping) |
|---|---|---|
| `startSpeakingPlan.waitSeconds` | `0.15` | `~1.2` |
| `stopSpeakingPlan.numWords` | `2` | `2` |
| `firstMessageMode` | `assistant-waits-for-user` | `firstMessage` |

`waitSeconds: 0.15` means Vance starts talking 150ms after the other
person stops making noise. Against a Bell rep working from a script,
that's snappy. Against someone thinking out loud about how their crews
schedule work, it interrupts every single time they pause mid-sentence —
and the calls where that happens are calls where you learn nothing,
because the person stops trying to explain.

This is one number, it is invisible in a code review, and it decides
whether the product works. Hence a named preset that a mission author
picks deliberately, rather than a knob they inherit.

Presets live in `src/vapi/conduct.ts`, with the acknowledgement-phrase
list (`"okay"`, `"mm-hmm"`, ...) shared by both so a listener's noises
never count as an interruption.

---

## Transient assistants

Today `npm run setup:vapi` provisions one Vapi assistant with the prompt
baked in, writes `.vapi-resources.json`, and `start-call` overrides only
`profile_text`.

Replace this with a **transient assistant per call**: build the whole
assistant config inline and pass it to `POST /call`.

Reasons, in order of how much they'll bite:

1. **Missions differ in more than prompt.** Tools, voice, speaking plan,
   duration cap and outcome schema all vary. Overriding a baked assistant
   can't express that cleanly.
2. **No drift.** Edit a mission file, redeploy, the next call uses it.
   With provisioned assistants, the file and the Vapi resource disagree
   the moment someone forgets to re-run sync.
3. **`.vapi-resources.json` doesn't survive Railway.** The filesystem is
   ephemeral. Transient assistants delete the problem instead of working
   around it.

`VAPI_ASSISTANT_ID` and `VAPI_CUSTOM_LLM_CREDENTIAL_ID` go away. The
custom-LLM credential still needs creating once — keep that as a small
`npm run setup:credential`, or configure the URL and key inline.

---

## Supervision

Three levels, and the default matters:

**A — solo, unwatched.** Vance runs the call alone; you read the
transcript afterward. Supported, and correct once a mission is proven.

**B — solo, supervised. This is the default.** Vance is still the only
voice the other party hears, but a human watches the live transcript and
holds three interventions, all through `monitor.controlUrl`:

```json
{ "type": "add-message",
  "message": { "role": "system", "content": "He mentioned subs twice. Dig into how subcontractors get scheduled." },
  "triggerResponseEnabled": true }
```

- **steer** — inject a system message mid-call, silently
- **end** — `{"type": "end-call"}`, ideally preceded by a `say` so the
  other party doesn't get a dead line
- **transfer** — hand the call to a human's own number when something
  comes up that only they can answer

The dashboard already has listen and hang-up. Steering is a text box and
one route. It is the highest-leverage thing in the build, because it
turns "the prompt was wrong and I found out afterward" into "the prompt
was wrong and I fixed it at minute four." It belongs in phase 1.

**C — human-led, Vance takes notes.** Rejected. That is transcription and
extraction, not an agent, and none of this architecture applies.

---

## Getting context in

Context is prose with no schema, which makes *typing it* the bottleneck.
A dashboard textarea works and is the phase-1 answer, but it is not the
good answer: nobody writes a rich brief into a browser box, so briefs end
up thin, and a thin brief is the difference between an interview and a
questionnaire.

**A small Telegram bot, in this repo.** Not in `jobsearch-platform` —
that is an invite-gated job-search product with a paywall, a scheduler
and worker machines, and its bot belongs to job seekers. Briefing Vance
about a client call has no place in that mental model, and the coupling
would run the wrong way. What is worth taking from there is the pattern,
and possibly `packages/telegram` verbatim, which is a thin Bot API
wrapper with no job-search knowledge in it.

The reason Telegram beats a textarea is not typing — it is **voice
notes**. Ramble for three minutes about the client, transcribe it, and
that transcript *is* the context prose. No format, no schema, exactly as
the design intends. Five times the brief for a fifth of the effort.
Forwarded emails land in the same bucket.

```
/new product-scoping jack
<voice note>
<forwarded email thread>
/call +1416...
```

**Then the endpoint of the idea: an `intake` mission.** Vance calls *you*
and interviews you about the upcoming call, and its structured outcome
becomes the context for the real mission. Elicitation feeding
elicitation, with the system briefing itself. Not for the first calls,
but the fact that it falls out naturally is a good sign the mission
abstraction is right.

---

## Outcomes

The fork's output is a transcript and a recording. That's right for a
negotiation, where the outcome is a fact you already heard. It's wrong
for elicitation, where the whole point is a structured artifact.

Add `analysisPlan.structuredDataSchema` from the mission's `outcome`
file. Vapi runs the extraction after the call and includes it in
`end-of-call-report`, which the server already receives at
`/vapi/events`.

For product scoping that schema is the actual deliverable, and it is
worth more care than the prompt: company profile, personas (including
**who won't use it** — a foreman in muddy gloves is the make-or-break
user), current tooling, the workflows that break today, offline
requirements, integrations, ranked must-haves, budget and timeline
signal, and who else decides.

**Persistence is deliberately deferred.** A dropped call feels like it
should lose everything, but `end-of-call-report` fires on abnormal
endings too, and `GET /call/:id` retains the artifact server-side. As
long as the call id is logged, nothing is lost. So phase one renders the
outcome in the dashboard and logs the JSON; a database can come when
there are enough calls to want a list.

---

## Latency, and the transcript that grows

Every turn re-sends the whole transcript, so total tokens grow
quadratically over a call. That is real, and it is *not* the main
problem. Worth ranking properly, because the obvious fix is the wrong
one.

Rough numbers for a 40-minute call: ~150 turns, a ~2k-token prefix
(CORE + mission + context), a transcript ending near 5k. Last request
~7k, average ~4.5k, call total somewhere near 700k input tokens — a
dollar or two. **The quadratic is a cost problem and the cost is small.**

### What was actually measured

Numbers below are against the deployed service on `gpt-5.5`, thinking
`minimal`, warmed up first (cold requests run 2–3× slower and quietly
poisoned an earlier round of measurements).

| | median first token | notes |
|---|---|---|
| 20-token system prompt | 2397ms | |
| 2112-token real prompt (CORE + mission + context) | 2287ms | no worse |
| buffered, same request | 2415ms | |

Three conclusions, two of which contradict what this file originally
predicted:

**Prompt size does not matter.** A 2k-token prompt is no slower than a
20-token one. Whatever the transcript costs, it is not first-token
latency.

**Streaming saves ~18ms on a median turn.** It was ranked as the single
biggest win and it is not. Time to first token is ~2.3s and completely
dominates; the model is doing nothing we can stream during that window.

**But streaming saves ~9 seconds on a long turn.** Two of six sampled
turns produced first token at ~1.3s and then kept generating until 10.4s
and 10.8s. Buffered, those are ten-second silences — long enough that a
person concludes the call has dropped and starts talking or hangs up.
So streaming is worth keeping: not as a median improvement, as tail
insurance against the turns that would otherwise break the call.

The remaining ~2.3s is model time-to-first-token, with a wide spread
(938ms to 4105ms observed). That variance is worse than the mean: a
consistently slow agent is something people adapt to, an unpredictable
one gets talked over. Levers not yet tried: a faster model tier, an
explicitly chosen region, and prompt caching — which on this evidence
should be pursued for cost rather than for latency.

**Rejected: summarising or windowing the transcript.** It is the obvious
fix and it is wrong here. A discovery call's whole value is that minute
38 connects to something said in minute 9. An agent that has compressed
away early detail will ask a question already answered — the single most
damaging thing it can do, because it tells the other person nobody is
listening. Keep the full transcript and make it cheap.

**Also rejected: holding the Pi agent in memory per `callId`** and
appending turns rather than rebuilding from Vapi's transcript. It saves
nothing — the model needs the full history either way, so token counts
are identical — and it costs the statelessness that lets the service
restart mid-call without consequence.

---

## Two archetypes, one engine

Worth writing down because it explains why the fork generalizes as well
as it does, and where it will strain:

| | **Transaction** (Bell) | **Elicitation** (scoping) |
|---|---|---|
| examples | negotiate, book, confirm, cancel | discovery, intake, screening |
| length | 5–20 min, mostly hold | 20–60 min, all conversation |
| who leads | Vance | mostly them |
| authority | real — commits on your behalf | none — only a refuse list |
| success | a commitment obtained | a schema filled |
| failure | agreed to the wrong thing | missed a topic, or invented one |

Same transport, same CORE, same dashboard. They differ in `conduct`, in
whether `outcome` is set, and in what the mission body spends its words
on. That's a good sign for the abstraction.

---

## Railway

Moving off Fly. `PORT` is already read from the environment and `/health`
already exists, so this is mostly deletion:

- remove `fly.toml`; keep or drop the `Dockerfile` (nixpacks handles a
  Node 22 app from `engines` + `npm start` without it)
- `PUBLIC_BASE_URL` = the Railway public domain, and it must be set
  *before* the first call, since it's how Vapi reaches the custom-LLM
  endpoint
- secrets as Railway variables, same list as `.env.example` minus the
  assistant/credential ids we're retiring
- **pick a US region.** Every conversational turn is Vapi → Railway →
  OpenAI → back. Region choice is directly in the audio latency budget,
  and this is the one Railway setting that isn't cosmetic.

---

## Known weaknesses

Documented, not solved.

**No dry run.** Every other system we build can be rehearsed. A phone
call to a real person cannot. The mitigation is to call yourself and play
the other party badly, twice, before any call that matters.

**Phone trees and hold** are handled entirely by CORE prose plus
`silenceTimeoutSeconds`. That was enough for Bell. A large chain's IVR
with a five-second menu timeout may not be, and that's when DTMF becomes
an engineering problem rather than a tool declaration.

**No queue, no retries, no dedupe.** Calls are started by hand from the
dashboard. A scheduling and retry engine is a real thing to want later —
most errand calls fail the first time for boring reasons — but building
it now would be inventing requirements. Revisit when a mission needs to
fire without a human present.

**Disclosure.** CORE currently answers truthfully only when asked. For
missions where Vance speaks to a third party on a client's behalf, it
should open with it — one line, up front. This is a launch blocker for
anything beyond self-testing (California SB 1001 among others), and
because "we'll come back to it" is exactly how this gets forgotten, it is
listed here rather than left as a comment.

---

## Phases

**0 — prove the transport.** Deploy the fork unchanged to Railway. Make
one test call to your own phone. Do this before touching any code, so
that the first failure is unambiguously ours.

**1 — generalize, and get the controls in hand.** Split CORE out of
`vapi-prompt.ts`. Mission loader. Conduct presets. Transient assistants.
Per-call destination and context from the dashboard. Relabel `"bell"` →
counterpart. Port the Bell prompt to `missions/bell-retention.md` and
re-run a call to confirm nothing regressed.

Two additions promoted into this phase because they are small and both
are wanted *before* a call that matters, not after:

- **real streaming** in `openAiSse` — the single biggest latency win
- **steering** — `add-message` route plus a dashboard text box, which is
  what makes supervision mode B real

**2 — outcomes.** `analysisPlan.structuredDataSchema` wired from the
mission; render the structured result in the dashboard alongside the
transcript.

**3 — the scoping mission.** Its prose and its schema, which is where the
real work is. Rehearse against your own phone, twice, playing the other
party badly.

**4 — Telegram context.** Standalone bot in this repo: text, forwarded
messages, and voice notes into a named context bucket. Voice-note-first,
because that is the whole point.

**Later.** The `intake` mission; incremental capture via a
locally-executed `note_finding` tool so a dropped call keeps its
findings; prompt caching; persistence; disclosure-by-default; and only if
genuinely needed, scheduling.

---

## Open

- **Prior context on the client** — brief, emails, complaints about their
  current setup. Dropped verbatim into context, it's the difference
  between an interview and a questionnaire. Needed for phase 3
  regardless of whether phase 4 exists yet.
- **Which model**, and whether it does prefix caching. Decides how much
  the transcript growth actually matters.
