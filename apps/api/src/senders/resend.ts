import { randomUUID } from "node:crypto";

import {
  AttemptError,
  DEFAULT_RETRY_POLICY,
  deliver,
  fetchFailure,
  isRetryableStatus,
  readJson,
  type RetryPolicy,
} from "./delivery.ts";
import type { EmailSender } from "./senders.ts";

export const RESEND_API_URL = "https://api.resend.com";

export interface ResendOptions {
  readonly apiKey: string;
  /** Sender, e.g. `nd <no-reply@example.com>`; its domain must be verified with Resend. */
  readonly from: string;
  readonly baseUrl?: string;
  readonly retry?: RetryPolicy;
}

/**
 * Sends email through Resend's HTTP API. Each message carries one
 * idempotency key across its retries, so a retry after a timeout cannot
 * send it twice.
 */
export function resendEmailSender(options: ResendOptions): EmailSender {
  const url = new URL("/emails", options.baseUrl ?? RESEND_API_URL);
  const policy = options.retry ?? DEFAULT_RETRY_POLICY;
  return {
    async send(message) {
      const idempotencyKey = randomUUID();
      const body = JSON.stringify({
        from: options.from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html === undefined ? {} : { html: message.html }),
      });
      await deliver(
        { channel: "email", provider: "Resend", recipient: message.to },
        policy,
        async (signal) => {
          const response = await fetch(url, {
            method: "POST",
            headers: {
              authorization: `Bearer ${options.apiKey}`,
              "content-type": "application/json",
              "idempotency-key": idempotencyKey,
            },
            body,
            signal,
          });
          if (response.ok) {
            await response.body?.cancel();
            return;
          }
          // Resend's error `message` can quote the recipient; keep only its name.
          const error = (await readJson(response)) as { name?: unknown } | undefined;
          const name = typeof error?.name === "string" ? error.name : undefined;
          throw new AttemptError({
            reason: `HTTP ${String(response.status)}${name === undefined ? "" : ` (${name})`}`,
            retryable: isRetryableStatus(response.status),
            status: response.status,
            providerCode: name,
          });
        },
        fetchFailure,
      );
    },
  };
}
