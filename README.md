# Vance

Vance is a voice agent that runs phone calls on your behalf. It navigates
IVRs, waits on hold, talks naturally with whoever picks up, does the thing it
was sent to do, and hangs up by itself.

What it does on any given call comes from a **mission** — one file describing
the errand. Negotiating a telecom bill is one mission. Scoping a product with a
client is another. Nothing in the code knows which.

Built with [Pi](https://github.com/earendil-works/pi/tree/main/packages/agent)
as the sole reasoning agent and [Vapi](https://vapi.ai/) as the phone layer.

```text
      phone call
          ↕
Vapi — audio, transcript, voice, DTMF, call control
          ↕
Vance server — OpenAI-compatible custom LLM endpoint
          ↕
Pi agent — reasoning, speech, keypad choices, hang-up
```

## How a call is assembled

```text
system prompt  =  CORE  +  mission body  +  context
```

- **CORE** (`src/prompt/core.ts`) is call craft: telling a human from a hold
  recording, staying silent through a menu, one-question-at-a-time turn taking,
  knowing when the call is finished. True of every call, written once.
- **The mission** (`missions/*.md`) is the errand. Frontmatter for the handful
  of things code branches on; the rest is prose.
- **The context** (`contexts/*.txt`, or pasted into the dashboard) is what you
  know going in, in your own words. No schema. Never committed — it usually
  holds an account number or something private about a client.

The agent is **stateless**: Vapi owns the transcript and hands over the whole
thing each turn, so the server can restart mid-call without anyone noticing,
and no database sits in the audio path.

## Missions

```markdown
---
name: product-scoping
description: Scope a software product with a prospective client
counterpart: client          # what to call the other side in the transcript
conduct: listening           # or: leading
opens: vance                 # or: them
firstMessage: Hi Jack, it's Vance calling on behalf of Karim...
tools: [endCall]             # add dtmf when there's a phone tree
maxMinutes: 60
---

You are running a scheduled discovery call to scope a software product...
```

`conduct` is the field to get right. `leading` starts speaking 150ms after the
other person stops — snappy against a rep working from a script. `listening`
waits 1.2s, because someone thinking out loud pauses mid-sentence, and an agent
that talks over them twice will stop being told anything useful.

## Setup

```bash
cp .env.example .env
npm ci
```

Fill in `.env`, then create the one Vapi resource that isn't per-call:

```bash
npm run setup:credential      # prints VAPI_CUSTOM_LLM_CREDENTIAL_ID
```

`PUBLIC_BASE_URL` must point at the deployed service before any call is placed
— it is how Vapi reaches the reasoning endpoint.

```bash
npm run dev                   # local server
npm run call -- line-check    # place a call
npm run call -- bell-retention +14165550100 my-bell-account
```

`line-check` is a two-minute self-test: it checks audio, reads back what it
heard, and asks you to interrupt it on purpose.

## Call room

Open the service URL and enter `DASHBOARD_KEY`. Pick a mission, type a number,
optionally paste context, and start the call. During the call you get:

- the live transcript, both sides
- a quiet listen-only audio monitor
- **Steer** — send Vance a private instruction mid-call. The other party hears
  nothing. This is what makes supervised calls worth running: a prompt that is
  subtly wrong gets corrected at minute four instead of discovered afterwards.
- **Hang up**

Steering and hang-up both need `monitorPlan.listenEnabled` and
`controlEnabled`, which every mission sets.

## Deploying on Railway

Node app, no Dockerfile. Set every value from `.env` as a Railway variable,
point `PUBLIC_BASE_URL` at the generated domain, and pick a **US region** —
each turn is Vapi → Railway → OpenAI → back, so region is in the latency
budget.

`/health` is the health check.

## Privacy and authorization

`.env`, real contexts, logs, and call data are excluded from Git. Keep them
that way. Rotate any credential that is accidentally committed.

Only use Vance where you are authorized to act. Follow the recording,
automated-calling, disclosure, and consent rules that apply where you and the
called party are. CORE instructs Vance to answer truthfully whenever asked
whether it is an AI; missions that speak to third parties on someone's behalf
should disclose up front, in the first breath. See `stories/` for why that is
tracked as a launch blocker rather than a preference.

## Verify

```bash
npm test
npm run typecheck
```

## License

[MIT](LICENSE)
