# HANDOFF

Where Vance stands as of **2026-08-10**. Read [AGENTS.md](AGENTS.md) for
the rules, [stories/](stories/) for design, and
[learnings/](learnings/README.md) before optimising anything.

Operator: **Karim** (pronounced *kuh-REEM*; write it "Kareem" anywhere it
will be spoken aloud).

## Status: working, in production, one real call delivered

The system places real calls, holds real conversations, and produces a
structured deliverable. It is not multi-user and has no database yet.

## Live deployment

| | |
|---|---|
| URL | `https://vance-production-4508.up.railway.app` |
| Railway project | `vance-agent` (`bf2f460f-968f-451a-9abe-c041bd48a774`) |
| Service | `vance` (`1ab873ba-…`) — the only one; an older one was deleted |
| Builder | Railpack, no Docker |
| Deploys | on push to `main` |
| Call room | the URL above, passcode is `DASHBOARD_KEY` |

Model: `gpt-5.5`, `PI_REASONING_EFFORT=none`, priority tier. ~900ms to
first token, 549–960ms spread.

## Branches

- **`main`** — deployed. Missions, CORE, conduct presets, transient
  assistants, streaming, steering, structured outcomes via Vapi.
- **`multi-user-briefs`** — *not deployed*. Phase 1 of the briefs story:
  Postgres schema, write-ahead persistence, the reconciler, and
  self-owned extraction (`src/extract.ts`, `npm run extract`). Typechecks,
  14 tests green, **never run against a real database.**

Everything on the branch is additive: with no `DATABASE_URL` every write
is a no-op and behaviour is identical to `main`. Verified directly.

## Missions

| mission | conduct | outcome schema | notes |
|---|---|---|---|
| `line-check` | listening | — | two-minute self-test: audio, read-back, deliberate interruption |
| `bell-retention` | leading | — | ported from the original repo, **never run** since the rewrite |
| `product-scoping` | listening | yes | the one that has done real work |

## What has actually been proven on a phone

- **Phase 0** — call connects, conversation holds, Vance ends the call
  itself (so tool calls round-trip Pi → us → Vapi). 57s, $0.089.
- **Two scoping rehearsals** against the operator's own phone.
- **One real 24-minute scoping call** with a client (Jack, construction
  firm in Montreal). 145 turns, $2.14. Went well.

Never exercised: `bell-retention` end to end, IVR/DTMF against a real
phone tree, hold queues, the reconciler, anything with a database.

## Known issues

**Vapi's structured extraction is unreliable on long calls.** On the
24-minute call `analysis` returned a summary and *no* `structuredData`,
with no error. The same config worked on a 70-second test. Recovered by
re-extracting from the transcript. The fix — extraction we own, plus a
reconciler fallback — exists on `multi-user-briefs` and is **not on
`main`**. Until it is merged, a long call may silently produce no
deliverable; recover with `npm run extract -- <call-id>`.

**Contexts do not reach production automatically.** Gitignored, therefore
absent from the deployed image. Production reads `CONTEXT_<MISSION>`
(currently only `CONTEXT_PRODUCT_SCOPING` is set). Editing the local file
changes nothing until that variable is updated.

**Disclosure is per-mission, not enforced.** `product-scoping` discloses
in its first line. CORE only requires honesty *when asked*. Before any
third-party use beyond the operator's own contacts this should be
enforced centrally — a launch blocker, recorded in
`stories/generalized-voice-missions.md`.

**One shared passcode.** `DASHBOARD_KEY` is not identity. Anyone with it
can spend money.

## Environment

See `.env.example`. Set on Railway, and locally in `.env` (gitignored):

`PUBLIC_BASE_URL`, `PI_SERVER_API_KEY`, `DASHBOARD_KEY`, `WEBHOOK_SECRET`,
`VAPI_API_KEY`, `VAPI_PHONE_NUMBER_ID`, `VAPI_CUSTOM_LLM_CREDENTIAL_ID`,
`VAPI_VOICE_PROVIDER`, `VAPI_VOICE_ID`, `VAPI_SILENCE_TIMEOUT_SECONDS`,
`OPENAI_API_KEY`, `PI_MODEL`, `PI_THINKING_LEVEL`, `PI_REASONING_EFFORT`,
`PI_SERVICE_TIER`, `DEFAULT_DESTINATION`, `CONTEXT_PRODUCT_SCOPING`.

`VAPI_CUSTOM_LLM_CREDENTIAL_ID` is created once by
`npm run setup:credential`. Assistants themselves are per call, so there
is no assistant id to maintain.

## Common tasks

```bash
npm ci
npm run dev                              # local server
npm run typecheck && npm test

npm run call -- line-check               # self-test to DEFAULT_DESTINATION
npm run call -- product-scoping +1…      # a real call
npm run extract -- latest                # re-extract a deliverable (no DB needed)

railway logs                             # runtime
railway logs --build <deployment-id>     # a SPECIFIC build; unqualified is stale
railway variables --set "K=V"
```

Outcomes land in `out/` (gitignored — client data).

## Next steps, in order

1. **Provision Railway Postgres** (~$5/mo) and verify `multi-user-briefs`:
   migrate, place a call, kill the process mid-call on purpose, confirm
   the reconciler recovers the transcript and extracts the outcome
   unaided. That is the test that matters; everything else is insertion.
2. **Consider merging the extraction fallback to `main` sooner** — it
   needs no database and would protect the next real call.
3. **Phase 2 of the briefs story**: define `InboundMessage` / `Channel`
   and refactor the dashboard to be the first adapter, proving the
   interface against something that already works.
4. **Phase 3**: identities, authorization, per-person budgets in SQL, and
   a decided PII posture — contexts hold account numbers and PINs, and
   moving them into Postgres changes the honest answer to "where does this
   data live".
5. **Phase 4**: a second channel, Telegram, voice-note-first. The real
   test of the interfaces.

Deferred by decision: the brief builder, and the `intake` mission (Vance
interviewing you to define a call, whose outcome creates a brief).

## Open questions

- Where results go by default. "Reply on the channel you were asked on"
  is the rule, but a scoping call produces a JSON document and SMS is a
  bad container. Probably a notification plus a link — which implies
  per-brief permalinks and a read path with real auth.
- Whether the call room grows a history view once results are in a
  database.
- Follow-ups from the client call: headcount, number of concurrent
  projects, timeline, budget and other decision-makers were never
  covered. The scoping schema recorded that gap itself, under
  `call_quality.topics_not_covered`.
