import { setTimeout as sleep } from "node:timers/promises";

// Timeouts, retries and errors shared by the real email and SMS providers.
// Errors name the provider and a masked recipient only: provider error
// messages can echo the address or number, so they are never passed on.

export type Channel = "email" | "sms";

/** `a***@example.com`: the first character of the local part and the domain. */
export function maskEmail(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${address.slice(0, 1)}***${address.slice(at)}`;
}

/** `***567`: the last three digits only. */
export function maskPhone(number: string): string {
  const digits = number.replace(/\D/g, "");
  return digits.length <= 3 ? "***" : `***${digits.slice(-3)}`;
}

export function maskRecipient(channel: Channel, recipient: string): string {
  return channel === "email" ? maskEmail(recipient) : maskPhone(recipient);
}

/** A message a provider did not accept. Safe to log: it never holds the full recipient. */
export class MessageDeliveryError extends Error {
  override name = "MessageDeliveryError";
  readonly channel: Channel;
  readonly provider: string;
  readonly recipient: string;
  /** HTTP status or SMTP reply code, when the provider answered. */
  readonly status: number | undefined;
  /** The provider's own error code (e.g. a Twilio error number), when it sent one. */
  readonly providerCode: string | undefined;
  readonly retryable: boolean;
  readonly attempts: number;

  constructor(input: {
    channel: Channel;
    provider: string;
    recipient: string;
    reason: string;
    status?: number | undefined;
    providerCode?: string | undefined;
    retryable: boolean;
    attempts: number;
  }) {
    const masked = maskRecipient(input.channel, input.recipient);
    super(
      `${input.provider} did not send the ${input.channel} to ${masked} after ${String(input.attempts)} attempt(s): ${input.reason}`,
    );
    this.channel = input.channel;
    this.provider = input.provider;
    this.recipient = masked;
    this.status = input.status;
    this.providerCode = input.providerCode;
    this.retryable = input.retryable;
    this.attempts = input.attempts;
  }
}

/** One attempt's failure, before it is turned into a `MessageDeliveryError`. */
export interface AttemptFailure {
  readonly reason: string;
  readonly retryable: boolean;
  readonly status?: number | undefined;
  readonly providerCode?: string | undefined;
}

/** Thrown by an attempt to report a classified failure. */
export class AttemptError extends Error {
  readonly failure: AttemptFailure;
  constructor(failure: AttemptFailure) {
    super(failure.reason);
    this.failure = failure;
  }
}

export interface RetryPolicy {
  /** Attempts in total, the first included. */
  readonly attempts: number;
  /** Wait before the second attempt; doubles for each one after. */
  readonly baseDelayMs: number;
  /** Abandon one attempt after this long. */
  readonly timeoutMs: number;
  /** Waits between attempts; tests pass one that returns at once. */
  readonly sleep?: (ms: number) => Promise<unknown>;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 300,
  timeoutMs: 10_000,
};

/** Whether an HTTP status is worth retrying: server errors and rate limits. */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

/** Classifies an error from `fetch`: timeouts and network failures are retried. */
export function fetchFailure(error: unknown): AttemptFailure {
  if (error instanceof AttemptError) return error.failure;
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return { reason: "timed out", retryable: true };
  }
  return { reason: "network error", retryable: true };
}

/**
 * Runs `attempt` until it succeeds, fails with something not worth retrying,
 * or runs out of attempts. Each attempt gets an abort signal that fires after
 * the policy's timeout.
 */
export async function deliver<T>(
  context: { channel: Channel; provider: string; recipient: string },
  policy: RetryPolicy,
  attempt: (signal: AbortSignal) => Promise<T>,
  classify: (error: unknown) => AttemptFailure,
): Promise<T> {
  const wait = policy.sleep ?? sleep;
  let failure: AttemptFailure = { reason: "not attempted", retryable: false };
  let attempts = 0;
  while (attempts < policy.attempts) {
    if (attempts > 0) await wait(policy.baseDelayMs * 2 ** (attempts - 1));
    attempts += 1;
    try {
      return await attempt(AbortSignal.timeout(policy.timeoutMs));
    } catch (error) {
      failure = classify(error);
      if (!failure.retryable) break;
    }
  }
  throw new MessageDeliveryError({ ...context, ...failure, attempts });
}

/** Reads a JSON body without failing on one that is not JSON. */
export async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
