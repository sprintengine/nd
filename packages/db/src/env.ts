import { parseEnv } from "@nd/config";
import { z } from "zod";

/** Environment the database package reads. */
export const dbEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
});

/** Reads and validates `DATABASE_URL` from the environment. */
export function databaseUrlFromEnv(
  source: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return parseEnv(dbEnvSchema, source).DATABASE_URL;
}
