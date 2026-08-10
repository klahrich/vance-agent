import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * Per-call background, in the caller's own words.
 *
 * Kept out of git: a mission is reusable and belongs in the repo, but context
 * is one call's worth of detail and routinely holds account numbers, PINs, or
 * a client's private situation. `contexts/` is gitignored except the example.
 *
 * Which is precisely the trap. Because the files are gitignored they are not
 * in the deployed image either, so a context that works locally is silently
 * empty in production — the agent still calls, still sounds fine, and simply
 * knows nothing. That happened. Hence the env fallback: on a deployed
 * service, context arrives as CONTEXT_<MISSION> rather than as a file.
 */
export function contextEnvName(missionName: string): string {
  return `CONTEXT_${missionName.toUpperCase().replace(/-/g, "_")}`;
}

export async function loadContextText(contextId: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]+$/.test(contextId)) throw new Error("Invalid context id");
  const fromEnv = process.env[contextEnvName(contextId)];
  if (fromEnv?.trim()) return fromEnv;
  return readFile(resolve(process.cwd(), "contexts", `${contextId}.txt`), "utf8");
}

/** Whether a call for this mission would carry any background at all, for the
 *  dashboard to warn about before dialling rather than after. */
export async function hasContext(missionName: string): Promise<boolean> {
  try {
    return (await loadContextText(missionName)).trim().length > 0;
  } catch {
    return Boolean(process.env.VANCE_CONTEXT_TEXT?.trim());
  }
}
