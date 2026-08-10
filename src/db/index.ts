// Database access. Every query in the service goes through this module.
//
// Persistence is OPTIONAL. With no DATABASE_URL, `store` is null and Vance
// behaves exactly as it did before this existed: calls still work, results
// still reach the dashboard, nothing is written down. That is deliberate —
// the operator's laptop and a CI run should not need a database to place a
// call, and it keeps this change additive rather than load-bearing before it
// has been proven.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import postgres from "postgres";

export type Sql = postgres.Sql<{}>;

let client: Sql | null | undefined;

/** Null when DATABASE_URL is unset. Callers must handle that. */
export function db(): Sql | null {
  if (client !== undefined) return client;
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn("[db] DATABASE_URL not set — results will not be persisted");
    client = null;
    return client;
  }
  client = postgres(url, {
    max: 4,
    idle_timeout: 20,
    connect_timeout: 10,
    // Railway's internal networking terminates TLS for us; over the public
    // proxy it does not. `prefer` covers both without a per-environment flag.
    ssl: url.includes("railway.internal") ? false : "prefer",
    onnotice: () => {},
  });
  return client;
}

export function persistenceEnabled(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

export async function migrate(): Promise<void> {
  const sql = db();
  if (!sql) throw new Error("DATABASE_URL is not set");
  const schema = await readFile(resolve(process.cwd(), "src/db/schema.sql"), "utf8");
  await sql.unsafe(schema);
}

export async function closeDb(): Promise<void> {
  if (client) await client.end({ timeout: 5 });
  client = undefined;
}
