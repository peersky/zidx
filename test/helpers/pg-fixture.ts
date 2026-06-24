import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import postgres from "postgres";
import { runMigrations } from "../../src/db/migrate.js";

export interface PgFixture {
  container: StartedPostgreSqlContainer;
  sql: postgres.Sql;
  url: string;
  shutdown: () => Promise<void>;
}

export async function startPg(): Promise<PgFixture> {
  const container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("indexer_test")
    .withUsername("indexer")
    .withPassword("indexer")
    .start();
  const url = container.getConnectionUri();
  const sql = postgres(url, { max: 3, onnotice: () => {} });
  await runMigrations(sql);
  return {
    container,
    sql,
    url,
    shutdown: async () => {
      await sql.end({ timeout: 5 });
      await container.stop();
    },
  };
}
