-- Vance persistence. Applied idempotently by `npm run db:migrate`.
--
-- Two unique constraints do the real work here:
--   identities (channel, channel_user_id)   -- one person, many ways in
--   calls.vapi_call_id                      -- every write is an upsert
--
-- The second is what makes durability cheap. A webhook delivered twice, a
-- reconciler racing a webhook, and a replay after a redeploy all collapse to
-- the same row instead of duplicating a call.

create table if not exists people (
  id           bigserial primary key,
  display_name text,
  created_at   timestamptz not null default now()
);

-- A person is reachable on several channels and is the same person on all of
-- them. Keeping this separate from `people` from the start avoids a migration
-- the first time someone texts from a number we have only ever emailed.
create table if not exists identities (
  id              bigserial primary key,
  person_id       bigint not null references people(id) on delete cascade,
  channel         text   not null,
  channel_user_id text   not null,
  created_at      timestamptz not null default now(),
  unique (channel, channel_user_id)
);

-- One intended call. Messages append to it; a call is dispatched from it.
create table if not exists briefs (
  id             bigserial primary key,
  person_id      bigint references people(id) on delete set null,
  mission        text not null,
  destination    text not null,
  context        text not null default '',
  source_channel text not null default 'web',
  status         text not null default 'ready',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- The raw contributions a brief was assembled from, kept verbatim. Every
-- channel retries, so (channel, external_id) is the idempotency key.
create table if not exists brief_messages (
  id          bigserial primary key,
  brief_id    bigint not null references briefs(id) on delete cascade,
  channel     text   not null,
  external_id text   not null,
  sender      text,
  body        text   not null,
  received_at timestamptz not null default now(),
  unique (channel, external_id)
);

-- Written BEFORE the phone rings. A call we have no record of is the one
-- failure this schema exists to prevent.
create table if not exists calls (
  id            bigserial primary key,
  brief_id      bigint references briefs(id) on delete set null,
  vapi_call_id  text not null unique,
  mission       text not null,
  destination   text,
  status        text,
  ended_reason  text,
  started_at    timestamptz,
  ended_at      timestamptz,
  cost          numeric,
  -- Set once a terminal call has been confirmed against Vapi. Null means the
  -- reconciler still owns this row, whatever the webhooks claimed.
  reconciled_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists calls_unreconciled_idx
  on calls (created_at) where reconciled_at is null;

-- What the call produced. On an elicitation mission `structured_data` is the
-- entire deliverable, which is why it gets a column rather than a log line.
create table if not exists call_artifacts (
  call_id         bigint primary key references calls(id) on delete cascade,
  transcript      jsonb,
  summary         text,
  structured_data jsonb,
  recording_url   text,
  updated_at      timestamptz not null default now()
);
