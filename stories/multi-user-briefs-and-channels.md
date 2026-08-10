# Story: briefs, channels, and never losing a result

## Where we are

Vance runs a call described by a mission file plus a lump of context prose.
That context is keyed by **mission** — `contexts/product-scoping.txt`, or
`CONTEXT_PRODUCT_SCOPING` on the deployed service. One standing brief per
mission, one operator, one shared dashboard passcode, and nothing written
down anywhere afterwards.

Three things break the moment that stops being true:

1. **Context keyed by mission cannot serve two callers.** Two people
   scoping two products both want `product-scoping`, and they do not
   share a briefing.
2. **There is no way in except the dashboard.** Adding SMS, email,
   Telegram or X today would mean each one reaching into mission and call
   logic directly, and that is four copies of the same mistake.
3. **Nothing survives the process.** The transcript and the structured
   outcome live in memory for ten minutes and in a log line. On an
   elicitation mission the structured outcome *is* the deliverable.

## The one model change

Context has to be keyed by **the call**, not the mission. That object is a
**brief**: one intended call, accumulating.

```
channel adapter ──▶ inbound message ──▶ brief ──▶ call ──▶ outcome ──▶ reply
                                         ▲                              │
                                         └───── outcome may create ─────┘
                                                     a brief
```

A brief holds who asked for it, which mission, the destination, the
context prose, and eventually its result. Messages **append to a brief**;
they never create a call. That decoupling is the whole design: it is what
lets someone start a brief in Telegram, add a detail by SMS an hour
later, and dispatch it from the web room.

## Channels

The reason this is cheap is a decision already made: **context is prose
with no schema.** A voice note, a forwarded email thread, a DM and a call
transcript are all already prose. Had context been a structured form,
every channel would need its own form-filling interface.

So the contract for an adapter is one sentence:

> **A channel's only job is to turn whatever arrived into prose, and to
> say who sent it.**

```ts
interface InboundMessage {
  channel: 'telegram' | 'sms' | 'email' | 'x' | 'voice' | 'web';
  channelUserId: string;   // who, in that channel's namespace
  externalId: string;      // dedupe key — every channel retries
  text: string;            // already transcribed / extracted
  attachments?: Attachment[];
  receivedAt: Date;
}

interface Channel {
  name: string;
  notify(person: Person, message: string): Promise<void>;
}
```

`notify` is the half that gets forgotten. **Reply on the channel you were
asked on.** A brief that arrives by SMS should return its outcome by SMS,
not sit in a web page nobody opens.

What an adapter must **not** do: know what a mission is, decide when a
brief is ready, place a call, or interpret its own text. Transcription
and attachment extraction happen inside the adapter — that is the only
channel-specific intelligence permitted, because it is exactly the work
of turning arrival into prose.

Voice notes are the reason Telegram will be worth more than a textarea:
three minutes of rambling produces a far richer brief than anyone types,
and the transcript *is* the context, verbatim, no format required.

## Identity

`people`, and `identities` keyed `(channel, channel_user_id)` pointing at
a person. Unavoidable the moment the same human texts and emails, and
cheap to add now rather than retrofit.

Unrecognised sender: create nothing, reply once with how to get access.
Silence is worse — people assume it worked.

## Durability

The original sketch was a local inbox updated during the call and written
to the database at the end. **Save-at-the-end is exactly when things are
lost**, and there is precedent: the sibling jobsearch-platform flushes
`conversation_events` from memory after five minutes of idle and its own
docs concede a restart loses the last segment. That is acceptable for a
chat transcript and not for a deliverable.

Invert the guarantee. Three layers, in order of importance:

**1. Write-ahead (synchronous, non-negotiable).** The brief is persisted
before dialling; the call row is created at dial time carrying the Vapi
call id. No call can exist that we have no record of, and no result can
arrive that we cannot attach to something.

**2. Append during (an optimisation).** Transcript upserted as events
arrive. This is what makes the live view survive a browser refresh. It is
explicitly *not* the guarantee, and it is fine for it to miss segments.

**3. Reconcile after (the actual guarantee).** A periodic job finds calls
that are non-terminal, or terminal without an outcome, and re-fetches
`GET /call/:id`.

The insight worth keeping: **we do not need perfect in-flight capture,
because Vapi is already an authoritative store.** It retains the call,
transcript, recording and analysis server-side. Our database is a
materialised copy of something durable elsewhere. One reconciler closes
every gap at once — dropped webhook, process death mid-call, redeploy,
network blip, analysis arriving late.

If only one of the three gets built, build the reconciler.

`vapi_call_id UNIQUE` is what makes every one of those writes idempotent,
including a webhook delivered twice.

## Multi-user

In scope, because it is the reason for the rest.

**Authorization.** `DASHBOARD_KEY` is one shared password and is not an
identity. Someone who texts the SMS number must not be able to spend
money on the account. Every brief is owned by a person; every dispatch is
authorised against that person. Unknown identities cannot dial, full
stop.

**Budgets.** Calls cost ~$0.09/min plus model tokens. Per-person limits
belong in the dispatch query rather than in application code, for the
same reason the freemium gate does in the sibling repo: a rule enforced
in two places drifts, and the one that drifts is the one that costs
money.

**PII.** Contexts hold account numbers and PINs — that is precisely why
`contexts/` is gitignored today. Moving them into Postgres is a
deliberate change of posture. It needs a retention policy and, for the
context and transcript columns, encryption at rest. Recording a decision
here is not optional paperwork: right now the honest statement is "this
data never leaves the operator's laptop", and after this phase it stops
being true.

## What comes free later

**The recursion.** "Talk to Vance to define a call, then Vance makes it"
is not a special case once briefs exist: it is an `intake` mission whose
outcome schema *is* a brief — mission, destination, context prose — and
whose result is written as a new brief. One rule covers it: **an outcome
may create a brief.** That it needs no special-casing is the best
evidence the model is right.

**The brief builder** — the agent that reads accumulated messages, works
out what is still missing, and asks for it over whatever channel the
person is on. It is an elicitation agent, identical whether it runs over
SMS or over a phone call, which is the same shape as the onboarding
interview and the scoping mission.

Both are **deferred**. Until then a brief is explicit: mission,
destination, prose. Which conveniently sidesteps the question of how
loose messages group into briefs — with explicit briefs there is nothing
to infer.

## Schema

| table | purpose |
|---|---|
| `people` | one row per human |
| `identities` | `(channel, channel_user_id)` unique → person |
| `briefs` | mission, destination, context, status, requested_by, source_channel |
| `brief_messages` | raw contributions; `(channel, external_id)` unique → idempotency |
| `calls` | brief_id, `vapi_call_id` unique, status, timings, ended_reason, cost |
| `call_artifacts` | transcript, summary, `structured_data`, recording_url |

Railway Postgres, `postgres.js`. Six tables, two unique constraints doing
the real work.

## Phasing

**1 — persistence.** Postgres, the six tables, write-ahead at dial time,
transcript append, outcome capture, and the reconciler. No behaviour
change visible in the dashboard beyond results that no longer vanish.

**2 — the interfaces, proven on the channel we have.** Define
`InboundMessage` and `Channel`, then **refactor the web dashboard to be
the first adapter.** Implementing the interface against something that
already works is what proves it is general, before anything depends on
it being general.

**3 — people and authorization.** Identities, ownership, per-person
budgets in SQL, PII posture decided and written down.

**4 — the second channel** (Telegram, voice-note-first). The real test:
if it needs anything outside the two interfaces, phase 2 was wrong.

Later: the brief builder, then the `intake` mission.

## Open

- **Where results go by default.** Reply on the source channel is the
  rule, but a 40-minute scoping call produces a JSON document, and an SMS
  is a bad container for it. Probably: a short notification on the source
  channel plus a link — which implies a per-brief permalink and therefore
  a read path with real auth. Worth settling before phase 3.
- **Whether the dashboard grows a history view.** Once results are in a
  database, "list my past calls" is nearly free and the current
  single-page call room can no longer be the whole product.
