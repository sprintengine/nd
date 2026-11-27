import { type Logger, pino } from "pino";

export type { Logger } from "pino";

/** Log levels the gateway accepts in `LOG_LEVEL`. */
export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Paths that are never written, even if a caller passes them by mistake:
 * credentials and idTags (a booking's idTag unlocks the charger).
 */
export const REDACTED_PATHS = [
  "authorization",
  "*.authorization",
  "headers.authorization",
  "*.headers.authorization",
  "password",
  "secret",
  "*.secret",
  "idTag",
  "*.idTag",
];

/** JSON logs to stdout (or `destination`), with secrets redacted. */
export function createLogger(
  options: { level?: LogLevel; destination?: pino.DestinationStream } = {},
): Logger {
  const settings = {
    level: options.level ?? "info",
    base: { service: "ocpp-gateway" },
    redact: { paths: REDACTED_PATHS, censor: "[redacted]" },
  };
  return options.destination === undefined ? pino(settings) : pino(settings, options.destination);
}
