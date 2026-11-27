/** An email to one recipient: plain text, and optionally the same content as HTML. */
export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

/** A text message to one phone number (E.164). */
export interface SmsMessage {
  readonly to: string;
  readonly body: string;
}

/** Sends email: SMTP or Resend in production (`from-env.ts`), the console in development and tests. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** Sends text messages: Twilio in production, the console in development and tests. */
export interface SmsSender {
  send(message: SmsMessage): Promise<void>;
}

/** Where console senders write. */
export type ConsoleSink = (line: string) => void;

const defaultSink: ConsoleSink = (line) => {
  console.info(line);
};

/**
 * Writes emails to the console instead of sending them, for local development.
 * With `redact` (production running with ALLOW_CONSOLE_MESSAGES) only the fact
 * that a message was dropped is written, never its content or recipient.
 */
export function consoleEmailSender(
  options: { redact?: boolean; sink?: ConsoleSink } = {},
): EmailSender {
  const { redact = false, sink = defaultSink } = options;
  return {
    send(message) {
      sink(
        redact
          ? "[email] not sent: no email provider is configured"
          : `[email] to ${message.to}: ${message.subject}\n${message.text}`,
      );
      return Promise.resolve();
    },
  };
}

/** Writes text messages to the console instead of sending them. See `consoleEmailSender`. */
export function consoleSmsSender(
  options: { redact?: boolean; sink?: ConsoleSink } = {},
): SmsSender {
  const { redact = false, sink = defaultSink } = options;
  return {
    send(message) {
      sink(
        redact
          ? "[sms] not sent: no SMS provider is configured"
          : `[sms] to ${message.to}: ${message.body}`,
      );
      return Promise.resolve();
    },
  };
}
