import { defineConfig } from "drizzle-kit";

// `pnpm --filter @nd/db db:generate` diffs src/schema against drizzle/meta and
// writes the next migration. Hand-written SQL (extensions, the booking
// exclusion constraint, the OCPP audit triggers) lives in custom migrations
// made with `pnpm --filter @nd/db db:generate --custom --name <name>`.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  strict: true,
  verbose: true,
});
