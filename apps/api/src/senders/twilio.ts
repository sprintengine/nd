import {
  AttemptError,
  DEFAULT_RETRY_POLICY,
  deliver,
  fetchFailure,
  isRetryableStatus,
  readJson,
  type RetryPolicy,
} from "./delivery.ts";
import type { SmsSender } from "./senders.ts";

export const TWILIO_API_URL = "https://api.twilio.com";

export interface TwilioOptions {
  readonly accountSid: string;
  readonly authToken: string;
  /** Send from this number (E.164) or alphanumeric sender id… */
  readonly from?: string | undefined;
  /** …or through this Messaging Service. One of the two is required. */
  readonly messagingServiceSid?: string | undefined;
  readonly baseUrl?: string;
  readonly retry?: RetryPolicy;
}

/** Sends text messages with Twilio's Messages REST API. */
export function twilioSmsSender(options: TwilioOptions): SmsSender {
  if (options.from === undefined && options.messagingServiceSid === undefined) {
    throw new Error("Twilio needs a sender number or a Messaging Service SID");
  }
  const url = new URL(
    `/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}/Messages.json`,
    options.baseUrl ?? TWILIO_API_URL,
  );
  const authorization = `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString("base64")}`;
  const policy = options.retry ?? DEFAULT_RETRY_POLICY;
  return {
    async send(message) {
      const form = new URLSearchParams({ To: message.to, Body: message.body });
      if (options.messagingServiceSid === undefined) form.set("From", options.from ?? "");
      else form.set("MessagingServiceSid", options.messagingServiceSid);
      await deliver(
        { channel: "sms", provider: "Twilio", recipient: message.to },
        policy,
        async (signal) => {
          const response = await fetch(url, {
            method: "POST",
            headers: { authorization, "content-type": "application/x-www-form-urlencoded" },
            body: form,
            signal,
          });
          if (response.ok) {
            await response.body?.cancel();
            return;
          }
          // Twilio's `message` often repeats the number; keep only its error code.
          const error = (await readJson(response)) as { code?: unknown } | undefined;
          const code = typeof error?.code === "number" ? String(error.code) : undefined;
          throw new AttemptError({
            reason: `HTTP ${String(response.status)}${code === undefined ? "" : ` (Twilio error ${code})`}`,
            retryable: isRetryableStatus(response.status),
            status: response.status,
            providerCode: code,
          });
        },
        fetchFailure,
      );
    },
  };
}
