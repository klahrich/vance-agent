// Apply src/db/schema.sql. Idempotent; safe to run on every deploy.
import "dotenv/config";
import { closeDb, migrate } from "../db/index.js";

await migrate();
console.log("Schema applied.");
await closeDb();
