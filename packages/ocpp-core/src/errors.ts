import type { z } from "zod";

import type { JsonObject, OcppErrorCode } from "./framing.ts";

/**
 * An OCPP-level failure with a CALLERROR code. Thrown by inbound handlers to
 * answer with a specific CALLERROR, and used to reject an outbound call that
 * the peer answered with a CALLERROR (`remote` is then true).
 */
export class OcppError extends Error {
  override readonly name = "OcppError";
  readonly code: OcppErrorCode;
  readonly details: JsonObject;
  readonly remote: boolean;

  constructor(
    code: OcppErrorCode,
    description: string,
    options: { details?: JsonObject; remote?: boolean; cause?: unknown } = {},
  ) {
    super(description, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.details = options.details ?? {};
    this.remote = options.remote ?? false;
  }
}

/** An outbound call got no CALLRESULT or CALLERROR within its timeout. */
export class OcppTimeoutError extends Error {
  override readonly name = "OcppTimeoutError";
  readonly action: string;
  readonly messageId: string;
  readonly timeoutMs: number;

  constructor(action: string, messageId: string, timeoutMs: number) {
    super(`${action} (${messageId}) got no reply within ${String(timeoutMs)} ms`);
    this.action = action;
    this.messageId = messageId;
    this.timeoutMs = timeoutMs;
  }
}

function valueAt(input: unknown, path: readonly PropertyKey[]): { found: boolean; value: unknown } {
  let current: unknown = input;
  for (const key of path) {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<PropertyKey, unknown>)[key];
  }
  return { found: true, value: current };
}

/** The CALLERROR code OCPP-J prescribes for one schema violation. */
export function errorCodeForIssue(issue: z.core.$ZodIssue, input: unknown): OcppErrorCode {
  switch (issue.code) {
    case "invalid_type":
      // A required property that is absent breaks its occurrence constraint;
      // one that is present with the wrong JSON type breaks its type constraint.
      if (issue.path.length > 0 && !valueAt(input, issue.path).found) {
        return "OccurenceConstraintViolation";
      }
      return issue.path.length === 0 ? "FormationViolation" : "TypeConstraintViolation";
    case "unrecognized_keys":
      return "FormationViolation";
    case "too_small":
    case "too_big":
      return issue.origin === "array"
        ? "OccurenceConstraintViolation"
        : "PropertyConstraintViolation";
    case "invalid_value":
    case "invalid_format":
    case "not_multiple_of":
    case "invalid_union":
    case "invalid_key":
    case "invalid_element":
    case "custom":
      return "PropertyConstraintViolation";
  }
}

/** Turns a failed schema parse into the OcppError to answer an inbound CALL with. */
export function ocppErrorFromZod(error: z.ZodError, input: unknown): OcppError {
  const issues = error.issues;
  // Report the most structural problem first: formation, then occurrence, then type, then value.
  const order: readonly OcppErrorCode[] = [
    "FormationViolation",
    "OccurenceConstraintViolation",
    "TypeConstraintViolation",
    "PropertyConstraintViolation",
  ];
  const codes = issues.map((issue) => errorCodeForIssue(issue, input));
  const code = order.find((candidate) => codes.includes(candidate)) ?? "FormationViolation";
  const description = issues
    .map((issue) =>
      issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
    )
    .join("; ");
  return new OcppError(code, description.slice(0, 255), {
    details: {
      issues: issues.map((issue) => ({ path: issue.path.map(String), message: issue.message })),
    },
  });
}
