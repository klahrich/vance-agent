// Mission files: frontmatter for the machine, prose for the model.
//
// Deliberately hand-rolled rather than pulling in a YAML parser. The
// frontmatter surface is a handful of scalars and one inline array; a
// dependency would be more code to audit than the parser it replaces.
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Conduct, Mission, Opens } from "./types.js";

const MISSION_DIR = () => resolve(process.cwd(), "missions");
const CONDUCTS: Conduct[] = ["leading", "listening"];
const OPENS: Opens[] = ["vance", "them"];

function parseScalar(raw: string): string | number | string[] {
  const value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  const unquoted = value.replace(/^["']|["']$/g, "");
  return /^-?\d+$/.test(unquoted) ? Number(unquoted) : unquoted;
}

function splitFrontmatter(source: string): { fields: Record<string, unknown>; body: string } {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error("mission file is missing its --- frontmatter --- block");
  const fields: Record<string, unknown> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator === -1) throw new Error(`unparseable frontmatter line: ${line}`);
    fields[line.slice(0, separator).trim()] = parseScalar(line.slice(separator + 1));
  }
  return { fields, body: match[2]!.trim() };
}

function str(fields: Record<string, unknown>, key: string, fallback?: string): string {
  const value = fields[key];
  if (typeof value === "string" && value !== "") return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`mission is missing required field: ${key}`);
}

/** Reject unknown names before they reach the filesystem. */
export function isMissionName(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

export async function loadMission(name: string): Promise<Mission> {
  if (!isMissionName(name)) throw new Error(`invalid mission name: ${String(name)}`);
  let source: string;
  try {
    source = await readFile(resolve(MISSION_DIR(), `${name}.md`), "utf8");
  } catch {
    throw new Error(`no such mission: ${name}`);
  }
  const { fields, body } = splitFrontmatter(source);
  if (!body) throw new Error(`mission ${name} has no body`);

  const conduct = str(fields, "conduct") as Conduct;
  if (!CONDUCTS.includes(conduct)) {
    throw new Error(`mission ${name}: conduct must be one of ${CONDUCTS.join(" | ")}`);
  }
  const opens = str(fields, "opens") as Opens;
  if (!OPENS.includes(opens)) {
    throw new Error(`mission ${name}: opens must be one of ${OPENS.join(" | ")}`);
  }
  const firstMessage = typeof fields.firstMessage === "string" ? fields.firstMessage : undefined;
  if (opens === "vance" && !firstMessage) {
    throw new Error(`mission ${name}: opens is "vance" so firstMessage is required`);
  }

  const tools = Array.isArray(fields.tools) ? (fields.tools as string[]) : ["endCall"];
  if (!tools.includes("endCall")) {
    // Without it the agent can only hang up by the far end doing it, and a
    // stuck call bills by the minute.
    throw new Error(`mission ${name}: tools must include endCall`);
  }
  const maxMinutes = typeof fields.maxMinutes === "number" ? fields.maxMinutes : 30;
  if (maxMinutes <= 0 || maxMinutes > 240) {
    throw new Error(`mission ${name}: maxMinutes must be between 1 and 240`);
  }

  const outcome = typeof fields.outcome === "string" ? fields.outcome : undefined;
  let outcomeSchema: Record<string, unknown> | undefined;
  if (outcome) {
    if (!/^[a-zA-Z0-9._-]+\.json$/.test(outcome)) {
      throw new Error(`mission ${name}: outcome must be a .json filename in missions/`);
    }
    let raw: string;
    try {
      raw = await readFile(resolve(MISSION_DIR(), outcome), "utf8");
    } catch {
      throw new Error(`mission ${name}: outcome schema not found: ${outcome}`);
    }
    try {
      outcomeSchema = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`mission ${name}: outcome schema is not valid JSON — ${(error as Error).message}`);
    }
    if (outcomeSchema.type !== "object" || typeof outcomeSchema.properties !== "object") {
      throw new Error(`mission ${name}: outcome schema must be an object schema with properties`);
    }
  }

  return {
    name,
    description: str(fields, "description"),
    counterpart: str(fields, "counterpart", "them"),
    conduct,
    opens,
    firstMessage,
    tools,
    maxMinutes,
    voice: typeof fields.voice === "string" ? fields.voice : undefined,
    outcome,
    outcomeSchema,
    body,
  };
}

/** Every mission on disk, for the dashboard picker. Invalid files are reported
 *  rather than silently skipped — a mission that fails to parse should be
 *  visible, not absent. */
export async function listMissions(): Promise<
  Array<{ name: string; description: string; error?: string }>
> {
  let entries: string[];
  try {
    entries = await readdir(MISSION_DIR());
  } catch {
    return [];
  }
  const names = entries
    .filter((file) => file.endsWith(".md"))
    .map((file) => file.slice(0, -3))
    .filter(isMissionName)
    .sort();

  return Promise.all(
    names.map(async (name) => {
      try {
        const mission = await loadMission(name);
        return { name, description: mission.description };
      } catch (error) {
        return { name, description: "", error: (error as Error).message };
      }
    }),
  );
}
