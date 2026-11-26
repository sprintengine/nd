import { z } from "zod";

/** Thrown when the process environment does not match the expected schema. */
export class EnvError extends Error {
  override name = "EnvError";
}

/** A TCP port read from an environment variable. */
export const port = z.coerce.number().int().min(0).max(65_535);

/**
 * Parses environment variables against a Zod schema and returns the typed result.
 *
 * Every deployable reads its configuration this way, so a missing or malformed
 * variable stops the process at start-up with a readable message.
 */
export function parseEnv<TSchema extends z.ZodType>(
  schema: TSchema,
  source: Readonly<Record<string, string | undefined>> = process.env,
): z.output<TSchema> {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvError(`Invalid environment:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
