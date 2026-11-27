import { describe, expect, it, vi } from "vitest";

import type { PushDevice } from "./push.ts";
import { isWebPushEndpoint, webPushPayload, webPushSender } from "./web-push.ts";

const vapid = { subject: "mailto:dev@example.com", publicKey: "pub", privateKey: "priv" };
const message = {
  title: "Charging started",
  body: "Your car is charging.",
  data: { kind: "charging_started" as const },
};
const device = (id: string, keys = true): PushDevice => ({
  id,
  platform: "web",
  token: `https://fcm.googleapis.com/fcm/send/${id}`,
  webPush: keys ? { p256dh: "p256", auth: "auth" } : null,
});

describe("webPushSender", () => {
  it("encrypts the payload to each subscription with the VAPID keys", async () => {
    const send = vi.fn().mockResolvedValue({ statusCode: 201 });
    expect(await webPushSender(vapid, send).send([device("a")], message)).toEqual([
      { status: "sent" },
    ]);
    expect(send).toHaveBeenCalledWith(
      { endpoint: "https://fcm.googleapis.com/fcm/send/a", keys: { p256dh: "p256", auth: "auth" } },
      webPushPayload(message),
      {
        vapidDetails: { subject: vapid.subject, publicKey: "pub", privateKey: "priv" },
        TTL: 86_400,
        urgency: "high",
        timeout: 10_000,
      },
    );
    expect(JSON.parse(webPushPayload(message))).toEqual(message);
  });

  it("treats 404 and 410 as expired subscriptions and retries throttling and server errors", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 410 })
      .mockRejectedValueOnce({ statusCode: 404 })
      .mockRejectedValueOnce({ statusCode: 429 })
      .mockRejectedValueOnce({ statusCode: 400 })
      .mockRejectedValueOnce(new Error("socket hang up"));
    const outcomes = await webPushSender(vapid, send).send(
      ["a", "b", "c", "d", "e"].map((id) => device(id)),
      message,
    );
    expect(outcomes).toEqual([
      { status: "invalid_token" },
      { status: "invalid_token" },
      { status: "failed", retryable: true, reason: "push service answered 429" },
      { status: "failed", retryable: false, reason: "push service answered 400" },
      { status: "failed", retryable: true, reason: "request failed" },
    ]);
  });

  it("never sends to an endpoint off the browser push services, and drops it", async () => {
    const send = vi.fn();
    const stored = { ...device("a"), token: "https://169.254.169.254/latest/meta-data" };
    expect(await webPushSender(vapid, send).send([stored], message)).toEqual([
      { status: "invalid_token" },
    ]);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not send to a subscription without keys", async () => {
    const send = vi.fn();
    expect(await webPushSender(vapid, send).send([device("a", false)], message)).toEqual([
      { status: "failed", retryable: false, reason: "subscription has no keys" },
    ]);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("isWebPushEndpoint", () => {
  it.each([
    "https://fcm.googleapis.com/fcm/send/abc:def",
    "https://updates.push.services.mozilla.com/wpush/v2/abc",
    "https://wns2-db5p.notify.windows.com/w/?token=abc",
    "https://web.push.apple.com/QGx3ZA",
  ])("accepts %s", (endpoint) => {
    expect(isWebPushEndpoint(endpoint)).toBe(true);
  });

  it.each([
    "http://fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com:8443/fcm/send/abc",
    "https://user:pass@fcm.googleapis.com/fcm/send/abc",
    "https://fcm.googleapis.com.example.com/x",
    "https://evilnotify.windows.com/x",
    "https://push.example.com/x",
    "https://127.0.0.1/x",
    "https://localhost/x",
    "not a url",
  ])("refuses %s", (endpoint) => {
    expect(isWebPushEndpoint(endpoint)).toBe(false);
  });
});
