# Vance

Vance is an autonomous voice agent that calls a telecom provider on your behalf. It navigates the IVR, waits on hold, verifies the account, talks naturally with a representative, negotiates the bill, confirms the final terms, and ends the call itself.

This version is built for Bell Canada using [Pi](https://github.com/earendil-works/pi/tree/main/packages/agent) as the sole reasoning agent and [Vapi](https://vapi.ai/) as the phone layer.

## What is in the repo

- One Pi agent controls the whole conversation—there is no separate Vapi strategist.
- Vapi handles transcription, voice, outbound calling, live monitoring, and keypad transport.
- Vance distinguishes automated menus from people, stays quiet during IVR prompts, and sends DTMF when needed.
- The account profile is ordinary text injected verbatim into the prompt. There is no JSON schema or deterministic parser.
- A password-protected web call room can start and end calls, show the live transcript, and play the listen-only audio stream.
- Long holds are supported with a configurable silence timeout.

```text
Bell phone call
      ↕
Vapi — audio, transcript, voice, DTMF
      ↕
Vance server — OpenAI-compatible custom LLM endpoint
      ↕
Pi agent — reasoning, speech, keypad choices, hang-up
```

## Requirements

- Node.js 22.19 or newer
- A Vapi account and a phone number that can place Canadian calls
- An OpenAI API key
- A public HTTPS URL for this service

The default brain configuration is `gpt-5.6-terra`, medium reasoning, and OpenAI Priority processing. Change `PI_MODEL` if that model is not available to your account.

## Setup

```bash
cp .env.example .env
cp profiles/example.txt profiles/my-bell-account.txt
npm ci
```

Fill in `.env`, then write anything Vance should know in `profiles/my-bell-account.txt` using normal language. Include the account holder's identity, verification details, current services, goals, preferences, and the decisions Vance is allowed to make. The profile has no required fields or formatting.

Start the Pi endpoint:

```bash
npm run dev
```

Provision a Vapi assistant backed directly by Pi:

```bash
npm run setup:vapi
```

Start a call from the command line:

```bash
npm run call -- my-bell-account
```

The command prints Vapi's listen-only monitor URL when one is available.

## Web call room

Open the service URL, enter `DASHBOARD_KEY`, type a destination number, and start the call. The dashboard shows call status, elapsed time, both sides of the transcript, and a quiet audio monitor. The **Hang up** button ends the Vapi call immediately.

For monitoring and hang-up to work, the Vapi assistant needs both `monitorPlan.listenEnabled` and `monitorPlan.controlEnabled` set to `true`. The setup command configures both.

`VAPI_SILENCE_TIMEOUT_SECONDS` defaults to 1,800 seconds so Vance can remain connected through long queues and transfers. `VAPI_MAX_DURATION_SECONDS` controls the overall call ceiling.

## Deploying on Fly.io

The included `Dockerfile` and `fly.toml` match the running deployment. Change the app name in `fly.toml`, create the app, and store every value from `.env` as a Fly secret before deploying. Never put credentials or the real account profile in `fly.toml`.

For a hosted deployment, store the raw profile in the `VANCE_PROFILE_TEXT` secret. Local development can continue to use `profiles/my-bell-account.txt`.

## Privacy and authorization

`.env`, Vapi resource IDs, real profiles, logs, and call data are excluded from Git. Keep them that way. Rotate any credential that is accidentally committed.

Only use Vance on an account you own or are authorized to manage. Follow the recording, automated-calling, disclosure, and consent rules that apply where you and the called party are located. The included prompt does not volunteer a technical announcement, but it instructs Vance to answer truthfully if directly asked whether it is AI.

## Verify

```bash
npm test
npm run typecheck
```

## License

[MIT](LICENSE)
