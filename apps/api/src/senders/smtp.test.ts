import { createServer, type Server } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MessageDeliveryError, type RetryPolicy } from "./delivery.ts";
import { type MailTransport, smtpEmailSender, smtpFailure } from "./smtp.ts";

const EMAIL = "niamh.walsh@example.com";
const fast: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 1,
  timeoutMs: 500,
  sleep: () => Promise.resolve(),
};

function scripted(...outcomes: (Error | "ok")[]) {
  const sent: unknown[] = [];
  const transport: MailTransport = {
    sendMail: (mail) => {
      sent.push(mail);
      const outcome = outcomes.shift() ?? "ok";
      return outcome === "ok" ? Promise.resolve({}) : Promise.reject(outcome);
    },
  };
  return { transport, sent };
}

const smtpError = (fields: { code?: string; responseCode?: number }) =>
  Object.assign(
    new Error(`Can't send mail - all recipients were rejected: 550 <${EMAIL}>`),
    fields,
  );

const options = { host: "smtp.example.com", port: 587, secure: false, from: "dev@example.com" };

describe("smtpFailure", () => {
  it("retries temporary SMTP replies and network errors only", () => {
    expect(smtpFailure(smtpError({ responseCode: 421, code: "EENVELOPE" }))).toMatchObject({
      retryable: true,
      status: 421,
    });
    expect(smtpFailure(smtpError({ responseCode: 550 }))).toMatchObject({ retryable: false });
    expect(smtpFailure(smtpError({ code: "ETIMEDOUT" }))).toMatchObject({ retryable: true });
    expect(smtpFailure(smtpError({ code: "EAUTH" }))).toMatchObject({ retryable: false });
    expect(smtpFailure("nonsense")).toMatchObject({ retryable: false, reason: "failed" });
    expect(smtpFailure(undefined)).toMatchObject({ retryable: false });
  });
});

describe("smtpEmailSender", () => {
  it("sends text and HTML from the configured sender", async () => {
    const { transport, sent } = scripted("ok");
    await smtpEmailSender({ ...options, transport, retry: fast }).send({
      to: EMAIL,
      subject: "Hi",
      text: "Hello",
      html: "<p>Hello</p>",
    });
    expect(sent).toEqual([
      { from: "dev@example.com", to: EMAIL, subject: "Hi", text: "Hello", html: "<p>Hello</p>" },
    ]);
  });

  it("retries a temporary failure", async () => {
    const { transport, sent } = scripted(smtpError({ responseCode: 451 }), "ok");
    await smtpEmailSender({ ...options, transport, retry: fast }).send({
      to: EMAIL,
      subject: "Hi",
      text: "Hello",
    });
    expect(sent).toHaveLength(2);
  });

  it("stops at a permanent failure and keeps the address out of the error", async () => {
    const { transport, sent } = scripted(smtpError({ responseCode: 550, code: "EENVELOPE" }));
    const error = await smtpEmailSender({ ...options, transport, retry: fast })
      .send({ to: EMAIL, subject: "Hi", text: "Hello" })
      .catch((caught: unknown) => caught);
    expect(sent).toHaveLength(1);
    expect(error).toBeInstanceOf(MessageDeliveryError);
    expect(error).toMatchObject({ status: 550, recipient: "n***@example.com", attempts: 1 });
    expect(JSON.stringify(error) + String(error)).not.toContain("niamh.walsh");
  });

  describe("over a real socket", () => {
    let server: Server;
    let port = 0;

    beforeAll(async () => {
      // Accepts connections and closes them at once: a broken mail server.
      server = createServer((socket) => socket.destroy());
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      port = typeof address === "object" && address !== null ? address.port : 0;
    });

    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
    });

    it("retries network failures, then reports them without the address", async () => {
      const error = await smtpEmailSender({
        host: "127.0.0.1",
        port,
        secure: false,
        user: "mailer",
        password: "secret",
        from: "dev@example.com",
        retry: fast,
      })
        .send({ to: EMAIL, subject: "Hi", text: "Hello" })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(MessageDeliveryError);
      expect(error).toMatchObject({ provider: "SMTP", attempts: 3, retryable: true });
      expect(String(error)).not.toContain("niamh.walsh");
    });
  });
});
