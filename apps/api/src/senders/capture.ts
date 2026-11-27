import type { EmailSender, SmsSender } from "./senders.ts";

// End-to-end test stacks only: senders that keep every message in memory, so
// a black-box test can read a sign-in link or phone code back through
// GET /e2e/messages. The environment schema allows them only with
// E2E_TEST_HOOKS=true, which production refuses.

/** A message a capture sender kept. */
export interface CapturedMessage {
  readonly channel: "email" | "sms";
  readonly to: string;
  /** Email only. */
  readonly subject: string | null;
  readonly text: string;
  readonly sentAt: string;
}

/** Messages kept in memory, oldest first, for end-to-end tests to read. */
export interface MessageCapture {
  readonly email: EmailSender;
  readonly sms: SmsSender;
  /** Messages to `to` (every message when undefined), oldest first. */
  list(to?: string): CapturedMessage[];
}

/** Most messages kept; the oldest are dropped first. */
export const CAPTURE_LIMIT = 1_000;

/** A new, empty capture. `now` stamps each message. */
export function createMessageCapture(
  options: { limit?: number; now?: () => Date } = {},
): MessageCapture {
  const { limit = CAPTURE_LIMIT, now = () => new Date() } = options;
  const messages: CapturedMessage[] = [];
  const keep = (message: CapturedMessage) => {
    messages.push(message);
    if (messages.length > limit) messages.splice(0, messages.length - limit);
    return Promise.resolve();
  };
  return {
    email: {
      send: (message) =>
        keep({
          channel: "email",
          to: message.to,
          subject: message.subject,
          text: message.text,
          sentAt: now().toISOString(),
        }),
    },
    sms: {
      send: (message) =>
        keep({
          channel: "sms",
          to: message.to,
          subject: null,
          text: message.body,
          sentAt: now().toISOString(),
        }),
    },
    list: (to) => messages.filter((message) => to === undefined || message.to === to),
  };
}
