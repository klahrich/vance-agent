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
 */
export async function loadContextText(contextId: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]+$/.test(contextId)) throw new Error("Invalid context id");
  return readFile(resolve(process.cwd(), "contexts", `${contextId}.txt`), "utf8");
}
