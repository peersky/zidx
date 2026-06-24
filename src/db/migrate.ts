import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { getSql, closeSql, type Sql } from "./client.js";

const log = pino({ name: "migrate" });

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

export async function runMigrations(sql: Sql = getSql()): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const applied: string[] = [];
  for (const file of files) {
    const content = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    await sql.unsafe(content);
    applied.push(file);
  }
  return applied;
}

async function main() {
  const sql = getSql();
  try {
    const applied = await runMigrations(sql);
    log.info({ applied }, "migrations applied");
  } finally {
    await closeSql();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    log.error({ err: err?.message }, "migration failed");
    process.exit(1);
  });
}
