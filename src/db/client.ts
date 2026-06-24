import postgres from "postgres";

const DEFAULT_URL = "postgres://postgres:postgres@localhost:5432/envio_db";

let sharedClient: postgres.Sql | null = null;

export function getSql(databaseUrl?: string): postgres.Sql {
  if (sharedClient) return sharedClient;
  const url = databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_URL;
  sharedClient = postgres(url, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
  });
  return sharedClient;
}

export async function closeSql(): Promise<void> {
  if (sharedClient) {
    await sharedClient.end({ timeout: 5 });
    sharedClient = null;
  }
}

export type Sql = postgres.Sql;
