// Command line for `pnpm db:migrate` and `pnpm db:seed`. Wiring only.
import { createDb } from "./client.ts";
import { databaseUrlFromEnv } from "./env.ts";
import { runMigrations } from "./migrate.ts";
import { seed } from "./seed.ts";

async function migrateCommand(databaseUrl: string): Promise<void> {
  await runMigrations(databaseUrl, {
    onNotice: (message) => {
      console.warn(message);
    },
  });
  console.log("Migrations applied.");
}

async function seedCommand(databaseUrl: string): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Refusing to seed with NODE_ENV=production.");
  }
  const database = createDb(databaseUrl, { max: 1 });
  try {
    const { inserted } = await seed(database.db);
    console.log(inserted ? "Seed data inserted." : "Seed data already present; nothing to do.");
  } finally {
    await database.close();
  }
}

const commands: Record<string, (databaseUrl: string) => Promise<void>> = {
  migrate: migrateCommand,
  seed: seedCommand,
};

const command = commands[process.argv[2] ?? ""];
if (command === undefined) {
  console.error("Usage: main.ts <migrate|seed>");
  process.exitCode = 2;
} else {
  await command(databaseUrlFromEnv());
}
