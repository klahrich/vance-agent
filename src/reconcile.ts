// The durability guarantee.
//
// Webhooks are the fast path and they are not trustworthy: one can be
// dropped, the process can die mid-call, a redeploy can land between the last
// transcript event and the end-of-call report, and Vapi's analysis arrives
// seconds after the call ends — comfortably long enough to miss.
//
// None of that matters, because Vapi already retains the call, its transcript,
// its recording and its analysis. Our database is a materialised copy of
// something durable elsewhere. So instead of trying to capture everything
// perfectly in flight, we re-read from the authoritative source afterwards and
// upsert. One loop closes every gap at once.
//
// If only one piece of the persistence work survives, it should be this one.
import { getVapiCall, type VapiCall, type VapiCallMessage } from "./vapi-api.js";
import { callsAwaitingReconciliation, markReconciled, saveArtifacts, updateCallProgress } from "./store.js";

const TERMINAL = new Set(["ended", "failed"]);
const INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_SECONDS ?? 120) * 1000;

function transcriptOf(call: VapiCall): VapiCallMessage[] | undefined {
  const messages = call.artifact?.messages ?? call.messages;
  return messages?.length ? messages : undefined;
}

/** Pull one call's true state from Vapi and write it down. Returns true once
 *  the call is finished and fully recorded, so it never needs visiting again. */
export async function reconcileCall(vapiCallId: string): Promise<boolean> {
  const call = await getVapiCall(vapiCallId);

  await updateCallProgress(vapiCallId, {
    status: call.status,
    endedReason: call.endedReason,
    startedAt: call.startedAt ?? null,
    endedAt: call.endedAt ?? null,
    cost: typeof (call as { cost?: number }).cost === "number" ? (call as { cost?: number }).cost! : null,
  });

  await saveArtifacts(vapiCallId, {
    transcript: transcriptOf(call),
    summary: call.analysis?.summary,
    structuredData: call.analysis?.structuredData,
    recordingUrl: call.artifact?.stereoRecordingUrl ?? call.artifact?.recordingUrl,
  });

  if (!TERMINAL.has(call.status ?? "")) return false;

  // A call can end before its analysis exists. Leaving it unreconciled costs
  // one more pass; marking it done early loses the deliverable permanently.
  const analysisPending = call.analysis === undefined || call.analysis === null;
  const endedRecently =
    call.endedAt !== undefined && Date.now() - Date.parse(call.endedAt) < 10 * 60_000;
  if (analysisPending && endedRecently) return false;

  await markReconciled(vapiCallId);
  return true;
}

export async function runReconcilerPass(): Promise<{ checked: number; settled: number }> {
  const ids = await callsAwaitingReconciliation();
  let settled = 0;
  for (const id of ids) {
    try {
      if (await reconcileCall(id)) settled += 1;
    } catch (error) {
      // Never let one bad call stall the queue; it will be retried next pass
      // and aged out after three days.
      console.warn(`[reconcile] ${id} failed:`, (error as Error).message);
    }
  }
  return { checked: ids.length, settled };
}

export function startReconciler(): void {
  const tick = async (): Promise<void> => {
    try {
      const { checked, settled } = await runReconcilerPass();
      if (checked) console.log(JSON.stringify({ event: "reconcile", checked, settled }));
    } catch (error) {
      console.warn("[reconcile] pass failed:", (error as Error).message);
    }
  };
  setInterval(() => void tick(), INTERVAL_MS).unref();
  void tick();
}
