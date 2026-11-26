import { type Dispatcher, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MessageDeliveryError, type RetryPolicy } from "./delivery.ts";
import { RESEND_API_URL, resendEmailSender } from "./resend.ts";
import { TWILIO_API_URL, twilioSmsSender } from "./twilio.ts";

const EMAIL = "aoife.byrne@example.com";
const PHONE = "+353861234567";
const SID = `AC${"0".repeat(32)}`;
const MESSAGES_PATH = `/2010-04-01/Accounts/${SID}/Messages.json`;

const waits: number[] = [];
const fast: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 100,
  timeoutMs: 200,
  sleep: (ms) => {
    waits.push(ms);
    return Promise.resolve();
  },
};

let agent: MockAgent;
let previous: Dispatcher;

beforeEach(() => {
  previous = getGlobalDispatcher();
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  waits.length = 0;
});

afterEach(async () => {
  agent.assertNoPendingInterceptors();
  setGlobalDispatcher(previous);
  await agent.close();
});

/** A mocked request's body, which the senders always send as a string. */
function bodyText(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error("unexpected request body");
}

/** The error a send rejected with. */
async function failure(promise: Promise<void>): Promise<MessageDeliveryError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(MessageDeliveryError);
  return error as MessageDeliveryError;
}

function expectNoRecipient(error: MessageDeliveryError, recipient: string) {
  const text = `${error.message} ${JSON.stringify(error)}`;
  expect(text).not.toContain(recipient);
  expect(text).not.toContain(recipient.slice(1));
}

describe("Resend", () => {
  const sender = () =>
    resendEmailSender({ apiKey: "re_test", from: "nd <no-reply@example.com>", retry: fast });

  it("posts the message with an idempotency key", async () => {
    let seen: { headers: Record<string, string>; body: unknown } | undefined;
    agent
      .get(RESEND_API_URL)
      .intercept({ path: "/emails", method: "POST" })
      .reply((request) => {
        seen = {
          headers: request.headers as Record<string, string>,
          body: JSON.parse(bodyText(request.body)) as unknown,
        };
        return { statusCode: 200, data: { id: "email-1" } };
      });
    await sender().send({ to: EMAIL, subject: "Hi", text: "Hello", html: "<p>Hello</p>" });
    expect(seen?.headers.authorization).toBe("Bearer re_test");
    expect(seen?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen?.body).toEqual({
      from: "nd <no-reply@example.com>",
      to: [EMAIL],
      subject: "Hi",
      text: "Hello",
      html: "<p>Hello</p>",
    });
  });

  it("retries server errors with the same idempotency key", async () => {
    const keys: string[] = [];
    const pool = agent.get(RESEND_API_URL);
    const record = (statusCode: number) => (request: { headers?: unknown }) => {
      keys.push((request.headers as Record<string, string>)["idempotency-key"] ?? "");
      return { statusCode, data: {} };
    };
    pool.intercept({ path: "/emails", method: "POST" }).reply(record(503));
    pool.intercept({ path: "/emails", method: "POST" }).reply(record(500));
    pool.intercept({ path: "/emails", method: "POST" }).reply(record(200));
    await sender().send({ to: EMAIL, subject: "Hi", text: "Hello" });
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
    expect(waits).toEqual([100, 200]);
  });

  it("does not retry a rejected message and never names the recipient", async () => {
    agent
      .get(RESEND_API_URL)
      .intercept({ path: "/emails", method: "POST" })
      .reply(422, { name: "validation_error", message: `Invalid \`to\` field: ${EMAIL}` });
    const error = await failure(sender().send({ to: EMAIL, subject: "Hi", text: "Hello" }));
    expect(error).toMatchObject({
      provider: "Resend",
      channel: "email",
      status: 422,
      providerCode: "validation_error",
      retryable: false,
      attempts: 1,
      recipient: "a***@example.com",
    });
    expectNoRecipient(error, EMAIL);
  });

  it("gives up after the last attempt on network errors", async () => {
    const pool = agent.get(RESEND_API_URL);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      pool
        .intercept({ path: "/emails", method: "POST" })
        .replyWithError(new Error("socket hang up"));
    }
    const error = await failure(sender().send({ to: EMAIL, subject: "Hi", text: "Hello" }));
    expect(error.attempts).toBe(3);
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/network error/);
    expectNoRecipient(error, EMAIL);
  });

  it("times out a slow provider and retries", async () => {
    const pool = agent.get(RESEND_API_URL);
    pool.intercept({ path: "/emails", method: "POST" }).reply(200, {}).delay(1_000);
    pool.intercept({ path: "/emails", method: "POST" }).reply(200, { id: "email-2" });
    await sender().send({ to: EMAIL, subject: "Hi", text: "Hello" });
    expect(waits).toEqual([100]);
  });

  it("reads an error body that is not JSON", async () => {
    agent
      .get(RESEND_API_URL)
      .intercept({ path: "/emails", method: "POST" })
      .reply(401, "Unauthorized");
    const error = await failure(sender().send({ to: EMAIL, subject: "Hi", text: "Hello" }));
    expect(error.message).toMatch(/HTTP 401/);
    expect(error.providerCode).toBeUndefined();
  });
});

describe("Twilio", () => {
  const sender = (
    from: { from?: string; messagingServiceSid?: string } = { from: "+15005550006" },
  ) => twilioSmsSender({ accountSid: SID, authToken: "token", retry: fast, ...from });

  it("posts a form with basic auth", async () => {
    let seen: { headers: Record<string, string>; body: URLSearchParams } | undefined;
    agent
      .get(TWILIO_API_URL)
      .intercept({ path: MESSAGES_PATH, method: "POST" })
      .reply((request) => {
        seen = {
          headers: request.headers as Record<string, string>,
          body: new URLSearchParams(bodyText(request.body)),
        };
        return { statusCode: 201, data: { sid: "SM1" } };
      });
    await sender().send({ to: PHONE, body: "Code 123456" });
    expect(seen?.headers.authorization).toBe(
      `Basic ${Buffer.from(`${SID}:token`).toString("base64")}`,
    );
    expect(Object.fromEntries(seen?.body ?? [])).toEqual({
      To: PHONE,
      Body: "Code 123456",
      From: "+15005550006",
    });
  });

  it("can send through a Messaging Service", async () => {
    let body: URLSearchParams | undefined;
    agent
      .get(TWILIO_API_URL)
      .intercept({ path: MESSAGES_PATH, method: "POST" })
      .reply((request) => {
        body = new URLSearchParams(bodyText(request.body));
        return { statusCode: 201, data: {} };
      });
    await sender({ messagingServiceSid: `MG${"1".repeat(32)}` }).send({ to: PHONE, body: "Hi" });
    expect(body?.get("MessagingServiceSid")).toBe(`MG${"1".repeat(32)}`);
    expect(body?.has("From")).toBe(false);
  });

  it("retries rate limits and server errors", async () => {
    const pool = agent.get(TWILIO_API_URL);
    pool.intercept({ path: MESSAGES_PATH, method: "POST" }).reply(429, { code: 20429 });
    pool.intercept({ path: MESSAGES_PATH, method: "POST" }).reply(502, "Bad Gateway");
    pool.intercept({ path: MESSAGES_PATH, method: "POST" }).reply(201, { sid: "SM2" });
    await sender().send({ to: PHONE, body: "Hi" });
    expect(waits).toEqual([100, 200]);
  });

  it("keeps the number out of errors even when Twilio repeats it", async () => {
    agent
      .get(TWILIO_API_URL)
      .intercept({ path: MESSAGES_PATH, method: "POST" })
      .reply(400, {
        code: 21211,
        message: `The 'To' number ${PHONE} is not a valid phone number.`,
        status: 400,
      });
    const error = await failure(sender().send({ to: PHONE, body: "Hi" }));
    expect(error).toMatchObject({
      provider: "Twilio",
      channel: "sms",
      status: 400,
      providerCode: "21211",
      retryable: false,
      recipient: "***567",
    });
    expectNoRecipient(error, PHONE);
  });

  it("needs a sender number or a Messaging Service", () => {
    expect(() => twilioSmsSender({ accountSid: SID, authToken: "token" })).toThrow(
      /Messaging Service/,
    );
  });
});
