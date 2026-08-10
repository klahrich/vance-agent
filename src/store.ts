// The persistence layer, in the vocabulary of the product rather than SQL.
//
// Every function here is a no-op when there is no database, so callers never
// branch on whether persistence is configured. And every write is safe to
// repeat: a webhook delivered twice, a reconciler racing that webhook, and a
// replay after a redeploy all land on the same row.
import { db } from "./db/index.js";
import type { Mission } from "./missions/types.js";

export interface BriefInput {
  mission: Mission;
  destination: string;
  context: string;
  sourceChannel: string;
  /** Channel-scoped identity of whoever asked. Resolved to a person, created
   *  on first sight. Until authorization exists (phase 3) this is effectively
   *  always the operator. */
  identity?: { channel: string; channelUserId: string; displayName?: string };
}

export interface CallArtifacts {
  transcript?: unknown;
  summary?: string;
  structuredData?: Record<string, unknown>;
  recordingUrl?: string;
}

async function resolvePersonId(identity: BriefInput["identity"]): Promise<number | null> {
  const sql = db();
  if (!sql || !identity) return null;
  const [existing] = await sql<{ person_id: number }[]>`
    select person_id from identities
    where channel = ${identity.channel} and channel_user_id = ${identity.channelUserId}
  `;
  if (existing) return existing.person_id;

  const [person] = await sql<{ id: number }[]>`
    insert into people (display_name) values (${identity.displayName ?? null}) returning id
  `;
  await sql`
    insert into identities (person_id, channel, channel_user_id)
    values (${person!.id}, ${identity.channel}, ${identity.channelUserId})
    on conflict (channel, channel_user_id) do nothing
  `;
  return person!.id;
}

/** Persist the intent to call, before anything is dialled. */
export async function createBrief(input: BriefInput): Promise<number | null> {
  const sql = db();
  if (!sql) return null;
  const personId = await resolvePersonId(input.identity);
  const [brief] = await sql<{ id: number }[]>`
    insert into briefs (person_id, mission, destination, context, source_channel, status)
    values (${personId}, ${input.mission.name}, ${input.destination}, ${input.context},
            ${input.sourceChannel}, 'dispatched')
    returning id
  `;
  return brief?.id ?? null;
}

/**
 * Record that a call exists, as soon as Vapi gives us an id.
 *
 * This is the one write that must happen synchronously and must not be
 * skipped: a call placed with no row is a cost we cannot explain and a result
 * we cannot attach to anything.
 */
export async function recordCallStarted(params: {
  briefId: number | null;
  vapiCallId: string;
  mission: string;
  destination: string;
  status?: string;
}): Promise<void> {
  const sql = db();
  if (!sql) return;
  await sql`
    insert into calls (brief_id, vapi_call_id, mission, destination, status)
    values (${params.briefId}, ${params.vapiCallId}, ${params.mission},
            ${params.destination}, ${params.status ?? "queued"})
    on conflict (vapi_call_id) do update set
      status = coalesce(excluded.status, calls.status),
      updated_at = now()
  `;
}

/** Progress updates during the call. Best effort by design — the reconciler
 *  is what guarantees the final state, so a missed update here costs nothing
 *  but liveness. */
export async function updateCallProgress(
  vapiCallId: string,
  fields: {
    status?: string;
    endedReason?: string;
    startedAt?: string | null;
    endedAt?: string | null;
    cost?: number | null;
  },
): Promise<void> {
  const sql = db();
  if (!sql) return;
  await sql`
    update calls set
      status       = coalesce(${fields.status ?? null}, status),
      ended_reason = coalesce(${fields.endedReason ?? null}, ended_reason),
      started_at   = coalesce(${fields.startedAt ?? null}::timestamptz, started_at),
      ended_at     = coalesce(${fields.endedAt ?? null}::timestamptz, ended_at),
      cost         = coalesce(${fields.cost ?? null}, cost),
      updated_at   = now()
    where vapi_call_id = ${vapiCallId}
  `;
}

/**
 * Write what the call produced.
 *
 * `coalesce` on every column so a later partial write cannot erase an earlier
 * complete one — the transcript often lands before the analysis, and the
 * reconciler may re-write both in any order.
 */
export async function saveArtifacts(
  vapiCallId: string,
  artifacts: CallArtifacts,
): Promise<void> {
  const sql = db();
  if (!sql) return;
  const [call] = await sql<{ id: number }[]>`
    select id from calls where vapi_call_id = ${vapiCallId}
  `;
  if (!call) return;
  await sql`
    insert into call_artifacts (call_id, transcript, summary, structured_data, recording_url)
    values (
      ${call.id},
      ${artifacts.transcript ? sql.json(artifacts.transcript as never) : null},
      ${artifacts.summary ?? null},
      ${artifacts.structuredData ? sql.json(artifacts.structuredData as never) : null},
      ${artifacts.recordingUrl ?? null}
    )
    on conflict (call_id) do update set
      transcript      = coalesce(excluded.transcript, call_artifacts.transcript),
      summary         = coalesce(excluded.summary, call_artifacts.summary),
      structured_data = coalesce(excluded.structured_data, call_artifacts.structured_data),
      recording_url   = coalesce(excluded.recording_url, call_artifacts.recording_url),
      updated_at      = now()
  `;
}

/** Which mission a call was placed under, so the reconciler can find its
 *  outcome schema without carrying the mission through every call site. */
export async function callMission(vapiCallId: string): Promise<string | null> {
  const sql = db();
  if (!sql) return null;
  const [row] = await sql<{ mission: string }[]>`
    select mission from calls where vapi_call_id = ${vapiCallId}
  `;
  return row?.mission ?? null;
}

export async function markReconciled(vapiCallId: string): Promise<void> {
  const sql = db();
  if (!sql) return;
  await sql`update calls set reconciled_at = now(), updated_at = now()
            where vapi_call_id = ${vapiCallId}`;
}

/** Calls the reconciler still owns: never confirmed against Vapi, and recent
 *  enough to be worth chasing. Old stragglers are left alone rather than
 *  retried forever. */
export async function callsAwaitingReconciliation(limit = 20): Promise<string[]> {
  const sql = db();
  if (!sql) return [];
  const rows = await sql<{ vapi_call_id: string }[]>`
    select vapi_call_id from calls
    where reconciled_at is null and created_at > now() - interval '3 days'
    order by created_at
    limit ${limit}
  `;
  return rows.map((row) => row.vapi_call_id);
}
