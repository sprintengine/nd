import { databaseUrlFromEnv, runMigrations } from "@nd/db";

/**
 * Applies pending database migrations and exits. The API image runs it as a
 * one-off container before a new version starts: `node dist/migrate.js`.
 */
export async function migrate(
  source: Readonly<Record<string, string | undefined>> = process.env,
  run: (databaseUrl: string) => Promise<void> = runMigrations,
  log: (message: string) => void = (message) => {
    console.info(message);
  },
): Promise<void> {
  log("applying database migrations");
  await run(databaseUrlFromEnv(source));
  log("database migrations applied");
}

if (import.meta.main) {
  await migrate();
}
