import { createTransport } from "nodemailer";

import {
  type AttemptFailure,
  DEFAULT_RETRY_POLICY,
  deliver,
  type RetryPolicy,
} from "./delivery.ts";
import type { EmailSender } from "./senders.ts";

/** The part of a nodemailer transport the sender uses. */
export interface MailTransport {
  sendMail(mail: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string;
  }): Promise<unknown>;
}

export interface SmtpOptions {
  readonly host: string;
  readonly port: number;
  /** TLS from the start (port 465). Otherwise STARTTLS is required. */
  readonly secure: boolean;
  readonly user?: string | undefined;
  readonly password?: string | undefined;
  /** Sender, e.g. `nd <no-reply@example.com>`. */
  readonly from: string;
  readonly retry?: RetryPolicy;
  /** A ready transport, for tests. */
  readonly transport?: MailTransport;
}

/** Network error codes nodemailer reports; all are worth another try. */
const NETWORK_CODES = new Set([
  "ECONNECTION",
  "ETIMEDOUT",
  "ESOCKET",
  "EDNS",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
]);

/**
 * Classifies a nodemailer error. SMTP's own convention applies to replies:
 * 4xx is a temporary failure (retried), 5xx is permanent (a rejected
 * recipient, a refused sender), which another try would not change.
 */
export function smtpFailure(error: unknown): AttemptFailure {
  const { code, responseCode } = (error ?? {}) as { code?: unknown; responseCode?: unknown };
  if (typeof responseCode === "number") {
    return {
      reason: `SMTP reply ${String(responseCode)}`,
      retryable: responseCode >= 400 && responseCode < 500,
      status: responseCode,
      providerCode: typeof code === "string" ? code : undefined,
    };
  }
  if (typeof code === "string") {
    return {
      reason: NETWORK_CODES.has(code) ? `network error (${code})` : `failed (${code})`,
      retryable: NETWORK_CODES.has(code),
      providerCode: code,
    };
  }
  return { reason: "failed", retryable: false };
}

/** Sends email over SMTP with nodemailer, requiring TLS. */
export function smtpEmailSender(options: SmtpOptions): EmailSender {
  const policy = options.retry ?? DEFAULT_RETRY_POLICY;
  const transport: MailTransport =
    options.transport ??
    createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      requireTLS: !options.secure,
      ...(options.user === undefined
        ? {}
        : { auth: { user: options.user, pass: options.password ?? "" } }),
      connectionTimeout: policy.timeoutMs,
      greetingTimeout: policy.timeoutMs,
      socketTimeout: policy.timeoutMs,
      // Never log message content or envelopes.
      logger: false,
      debug: false,
    });
  return {
    async send(message) {
      await deliver(
        { channel: "email", provider: "SMTP", recipient: message.to },
        policy,
        () =>
          transport.sendMail({
            from: options.from,
            to: message.to,
            subject: message.subject,
            text: message.text,
            ...(message.html === undefined ? {} : { html: message.html }),
          }),
        smtpFailure,
      );
    },
  };
}
