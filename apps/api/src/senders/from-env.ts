import type { ApiEnv } from "../env.ts";
import { createMessageCapture, type MessageCapture } from "./capture.ts";
import { resendEmailSender } from "./resend.ts";
import {
  consoleEmailSender,
  type ConsoleSink,
  consoleSmsSender,
  type EmailSender,
  type SmsSender,
} from "./senders.ts";
import { smtpEmailSender } from "./smtp.ts";
import { twilioSmsSender } from "./twilio.ts";

/** Reads a value the environment schema has already required. */
function required<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

/**
 * The email and SMS senders the environment chooses. Console senders are
 * the default for development; in production the environment schema allows
 * them only with ALLOW_CONSOLE_MESSAGES=true, and they then redact. With
 * E2E_TEST_HOOKS=true (never in production) `capture` is set, holding what
 * the `capture` senders kept for GET /e2e/messages.
 */
export function sendersFromEnv(
  env: ApiEnv,
  options: { sink?: ConsoleSink } = {},
): { email: EmailSender; sms: SmsSender; capture: MessageCapture | undefined } {
  const redact = env.NODE_ENV === "production";
  const capture = env.E2E_TEST_HOOKS === "true" ? createMessageCapture() : undefined;
  const consoleOptions = { redact, ...(options.sink === undefined ? {} : { sink: options.sink }) };

  let email: EmailSender;
  switch (env.EMAIL_PROVIDER) {
    case "smtp":
      email = smtpEmailSender({
        host: required(env.SMTP_HOST, "SMTP_HOST"),
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE === undefined ? env.SMTP_PORT === 465 : env.SMTP_SECURE === "true",
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
        from: required(env.EMAIL_FROM, "EMAIL_FROM"),
      });
      break;
    case "resend":
      email = resendEmailSender({
        apiKey: required(env.RESEND_API_KEY, "RESEND_API_KEY"),
        from: required(env.EMAIL_FROM, "EMAIL_FROM"),
      });
      break;
    case "capture":
      email = required(capture, "E2E_TEST_HOOKS=true").email;
      break;
    case "console":
      email = consoleEmailSender(consoleOptions);
      break;
  }

  let sms: SmsSender;
  switch (env.SMS_PROVIDER) {
    case "twilio":
      sms = twilioSmsSender({
        accountSid: required(env.TWILIO_ACCOUNT_SID, "TWILIO_ACCOUNT_SID"),
        authToken: required(env.TWILIO_AUTH_TOKEN, "TWILIO_AUTH_TOKEN"),
        from: env.TWILIO_FROM,
        messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID,
      });
      break;
    case "capture":
      sms = required(capture, "E2E_TEST_HOOKS=true").sms;
      break;
    case "console":
      sms = consoleSmsSender(consoleOptions);
      break;
  }

  return { email, sms, capture };
}
