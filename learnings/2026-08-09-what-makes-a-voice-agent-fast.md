# What makes a voice agent fast (and what doesn't)

**2026-08-09** — from generalizing this repo out of a single Bell
negotiation and getting the first calls working end to end.

Everything below was measured against the deployed service, not reasoned
about. Several of these overturn what I confidently predicted beforehand,
which is the main reason the file exists.

---

## 1. Reasoning effort is the whole latency story

| | median first token | spread |
|---|---|---|
| reasoning `low` | 2381ms | 938–4105ms |
| reasoning `none` | **902ms** | **549–960ms** |

2.6× on the median, and the spread collapsed from a 3.2-second range to
400ms.

Reasoning tokens are generated **before any text exists and cannot be
streamed**, so they land entirely inside the silence after the other
person stops speaking. Nothing else we tried came close.

It also makes sense once stated: a phone conversation is mostly reflex.
Ask the obvious follow-up, acknowledge, keep the thread. There is very
little to deliberate about, and the cost of deliberating is paid in the
one currency a call cannot spare.

**Rule:** reasoning off by default for conversational agents. Raise it
only for a mission that genuinely needs deliberation and can afford the
pause.

## 2. The spread matters more than the median

People adapt to an agent that is consistently slow. They talk over one
that is unpredictable, because a four-second gap is indistinguishable
from a dropped call, and once someone starts talking over the agent the
turn is lost.

Optimise p95, not the mean. A change that improves the average while
widening the tail is a regression.

## 3. Streaming is tail insurance, not a median win

Predicted: the single biggest win. Measured: **18ms** on a median turn.
Time to first token dominated so completely that streaming had almost
nothing left to save.

But two of six sampled turns produced a first token at ~1.3s and then
kept generating until **10.4s and 10.8s**. Buffered, those are
ten-second silences — long enough that a person concludes the call
dropped, and exactly the turns that break a conversation.

**Rule:** stream anyway, but for variance, not for speed. Justify it
that way so nobody "optimises" it out after seeing the median.

## 4. A failed LLM request looks like silence, not an error

Pi talks to the **Responses API**, where reasoning effort is
`reasoning.effort` — not the chat-completions `reasoning_effort`. Sending
the wrong one 400s on every single turn.

The symptom was not an error. By the time the request fails, the SSE
stream to Vapi has already been opened with a 200, so there is no status
code left to fail with. The agent simply never speaks. For the entire
call. On a real call this is indistinguishable from a bad line.

**Rule:** when a voice agent goes mute, suspect the model request before
the audio path. And log loudly at the point the stream is abandoned —
that log is the only evidence there is.

## 5. Measure warm, or don't measure

Cold requests run 2–3× slower than warm ones. An early round of
benchmarks was taken immediately after deploys and produced numbers that
were pure noise, which sent the whole investigation down the wrong path
for a while.

**Rule:** discard the first two or three requests. Anything measured
right after a deploy is junk.

## 6. Prompt size did not matter at all

A 2112-token system prompt (CORE + mission + context) was **no slower**
to first token than a 20-token one.

This killed a planned optimisation. The concern that a growing transcript
would slow the agent down over a long call is real for *cost* and
essentially false for *latency*. Do not compress the transcript to go
faster — and especially do not summarise it, because an agent that has
forgotten what was said in minute 9 will ask about it again in minute 38,
which is the most damaging thing it can do.

## 7. Turn-taking numbers are the product

`startSpeakingPlan.waitSeconds` decides whether the agent feels attentive
or feels like a robot, and it is invisible in a code review.

At `0.15` the agent starts talking 150ms after the other person stops
making noise. Against someone reading from a script that is snappy.
Against someone thinking out loud it interrupts every time they pause
mid-sentence — and after that happens twice, people stop trying to
explain things properly. On a call whose entire purpose is to learn
something, that is fatal.

**Rule:** name the intent (`leading` / `listening`) and let missions pick
one. Never let a mission inherit whatever the previous one happened to
need.

## 8. Prose beats schema for anything a human wrote

The instinct was to model the agent's authority as structured tiers —
fixed, negotiable-within-bounds, must-ask, with numeric bounds. The
original repo instead injects the caller's notes verbatim with no schema
at all, and it works better.

Real instructions carry nuance like *"he'll probably push for a fixed
price, don't take the bait"*, which no field expresses. The model reads
it fine.

**Rule:** structure only what code branches on. Everything else is prose.

## 9. Platform state can get stuck; recreating beats debugging

A Railway service reached a state where the API reported
`builder: RAILPACK` with an empty `dockerfilePath`, the dashboard showed
"Dockerfile — Automatically Detected" and refused to let it be changed,
and every build bounced across four builders and died without emitting a
single build step. The repo was clean and the commit matched.

Roughly 45 minutes went into that. Deleting the service and adding a
fresh one from the same GitHub repo worked on the first attempt, and took
about three minutes.

**Rule:** when a deploy target is internally inconsistent and holds no
state, recreate it. Set a time budget on debugging infrastructure that
can simply be replaced. Keep the variables somewhere you can re-push in
one command, which is what made this cheap.

## 10. Don't trust the dashboard over the API, or either over a deploy

The dashboard and the GraphQL API disagreed for half an hour. Both were
outranked by what the builder actually did. The only reliable signals
were the deployment list, the build log for a *specific* deployment id
(the unqualified command shows a stale successful build), and hitting the
endpoint.

---

## What this cost, for calibration

- ~$0.09/min of call time, plus model tokens
- a 57-second test call: $0.0887
- the whole day's benchmarking: a few dollars

Latency work was worth far more than cost work, and will stay that way
until calls run long or often.
