import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export async function loadProfileText(profileId: string): Promise<string> {
  if (!/^[a-zA-Z0-9_-]+$/.test(profileId)) throw new Error("Invalid profile id");
  return readFile(resolve(process.cwd(), "profiles", `${profileId}.txt`), "utf8");
}
