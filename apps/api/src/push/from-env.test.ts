import { describe, expect, it, vi } from "vitest";

import { apiEnvSchema } from "../env.ts";
import { pushFromEnv } from "./from-env.ts";

const base = {
  DATABASE_URL: "postgres://nd:nd@localhost:5432/nd",
  AUTH_SECRET: "x".repeat(32),
  GATEWAY_INTERNAL_SECRET: "g".repeat(32),
};
const ACCOUNT = { project_id: "nd-test", client_email: "push@example.com", private_key: "key" };
const VAPID = {
  VAPID_PUBLIC_KEY: Buffer.alloc(65, 4).toString("base64url"),
  VAPID_PRIVATE_KEY: Buffer.alloc(32, 9).toString("base64url"),
  VAPID_SUBJECT: "mailto:dev@example.com",
};
const fakeMessaging = () => vi.fn(() => ({ sendEach: vi.fn() }));

describe("pushFromEnv", () => {
  it("writes to the console without a provider, redacted in production", async () => {
    const lines: string[] = [];
    const push = pushFromEnv(apiEnvSchema.parse(base), { sink: (line) => lines.push(line) });
    expect(push.name).toBe("console");
    await push.send([{ id: "d", platform: "ios", token: "t", webPush: null }], {
      title: "T",
      body: "B",
      data: { kind: "guest_arrived" },
    });
    expect(lines).toEqual(["[push] to ios device d: T: B"]);
    const production = apiEnvSchema.parse({
      ...base,
      NODE_ENV: "production",
      PUBLIC_API_URL: "https://api.example.com",
      OCPP_WSS_URL: "wss://ocpp.example.com/v16/",
      ALLOW_CONSOLE_MESSAGES: "true",
      ALLOW_CONSOLE_PUSH: "true",
      TAX_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32).toString("base64")}`,
    });
    expect(pushFromEnv(production).name).toBe("console");
  });

  it("uses FCM from the JSON variable and web push from the VAPID keys", () => {
    const messaging = fakeMessaging();
    const push = pushFromEnv(
      apiEnvSchema.parse({ ...base, ...VAPID, FCM_SERVICE_ACCOUNT_JSON: JSON.stringify(ACCOUNT) }),
      { messaging },
    );
    expect(push.name).toBe("fcm+web-push");
    expect(messaging).toHaveBeenCalledWith(ACCOUNT);
    expect(pushFromEnv(apiEnvSchema.parse({ ...base, ...VAPID })).name).toBe("web-push");
  });

  it("reads the service account from a file, refusing one that is not a key", () => {
    const messaging = fakeMessaging();
    const env = apiEnvSchema.parse({ ...base, FCM_SERVICE_ACCOUNT_FILE: "/run/secrets/fcm.json" });
    expect(pushFromEnv(env, { messaging, readFile: () => JSON.stringify(ACCOUNT) }).name).toBe(
      "fcm",
    );
    expect(messaging).toHaveBeenCalledWith(ACCOUNT);
    expect(() => pushFromEnv(env, { messaging, readFile: () => "{}" })).toThrow(
      /FCM_SERVICE_ACCOUNT_FILE must hold a service account key/,
    );
  });
});
