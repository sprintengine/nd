import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { describe, expect, it } from "vitest";

import { apiEnvSchema } from "../env.ts";
import { sendersFromEnv } from "./from-env.ts";
import { RESEND_API_URL } from "./resend.ts";
import { TWILIO_API_URL } from "./twilio.ts";

const base = {
  DATABASE_URL: "postgres://nd:nd@localhost:5432/nd",
  AUTH_SECRET: "x".repeat(32),
  GATEWAY_INTERNAL_SECRET: "g".repeat(32),
};
const SID = `AC${"a".repeat(32)}`;

describe("sendersFromEnv", () => {
  it("writes to the console in development", async () => {
    const lines: string[] = [];
    const { email, sms } = sendersFromEnv(apiEnvSchema.parse(base), {
      sink: (line) => lines.push(line),
    });
    await email.send({ to: "dev@example.com", subject: "s", text: "link" });
    await sms.send({ to: "+353861234567", body: "code 123456" });
    expect(lines.join("\n")).toContain("code 123456");
  });

  it("redacts console output in production", async () => {
    const lines: string[] = [];
    const env = apiEnvSchema.parse({
      ...base,
      NODE_ENV: "production",
      PUBLIC_API_URL: "https://api.example.com",
      OCPP_WSS_URL: "wss://ocpp.example.com/v16/",
      ALLOW_CONSOLE_MESSAGES: "true",
      ALLOW_CONSOLE_PUSH: "true",
      TAX_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32).toString("base64")}`,
    });
    const { email } = sendersFromEnv(env, { sink: (line) => lines.push(line) });
    await email.send({ to: "dev@example.com", subject: "s", text: "link" });
    expect(lines).toEqual(["[email] not sent: no email provider is configured"]);
  });

  it("builds the SMTP sender", () => {
    const { email } = sendersFromEnv(
      apiEnvSchema.parse({
        ...base,
        EMAIL_PROVIDER: "smtp",
        EMAIL_FROM: "nd <no-reply@example.com>",
        SMTP_HOST: "smtp.example.com",
        SMTP_PORT: "465",
      }),
    );
    expect(typeof email.send).toBe("function");
    const explicit = sendersFromEnv(
      apiEnvSchema.parse({
        ...base,
        EMAIL_PROVIDER: "smtp",
        EMAIL_FROM: "no-reply@example.com",
        SMTP_HOST: "smtp.example.com",
        SMTP_SECURE: "false",
      }),
    );
    expect(typeof explicit.email.send).toBe("function");
  });

  it("sends through Resend and Twilio when chosen", async () => {
    const previous = getGlobalDispatcher();
    const agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    try {
      agent.get(RESEND_API_URL).intercept({ path: "/emails", method: "POST" }).reply(200, {});
      agent
        .get(TWILIO_API_URL)
        .intercept({ path: `/2010-04-01/Accounts/${SID}/Messages.json`, method: "POST" })
        .reply(201, {});
      const { email, sms } = sendersFromEnv(
        apiEnvSchema.parse({
          ...base,
          EMAIL_PROVIDER: "resend",
          EMAIL_FROM: "no-reply@example.com",
          RESEND_API_KEY: "re_test",
          SMS_PROVIDER: "twilio",
          TWILIO_ACCOUNT_SID: SID,
          TWILIO_AUTH_TOKEN: "token",
          TWILIO_FROM: "+15005550006",
        }),
      );
      await email.send({ to: "dev@example.com", subject: "s", text: "t" });
      await sms.send({ to: "+353861234567", body: "b" });
      agent.assertNoPendingInterceptors();
    } finally {
      setGlobalDispatcher(previous);
      await agent.close();
    }
  });

  it("refuses to build a provider the schema did not complete", () => {
    expect(() => sendersFromEnv({ ...apiEnvSchema.parse(base), EMAIL_PROVIDER: "resend" })).toThrow(
      /RESEND_API_KEY is required/,
    );
  });
});
