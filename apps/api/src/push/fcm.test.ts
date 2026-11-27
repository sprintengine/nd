import { describe, expect, it, vi } from "vitest";

import { fcmMessage, type FcmMessaging, fcmPushSender } from "./fcm.ts";
import type { PushDevice } from "./push.ts";

const BOOKING_ID = "11111111-1111-4111-8111-111111111111";
const message = {
  title: "Your guest has arrived",
  body: "They're at your charger.",
  data: { kind: "guest_arrived" as const, bookingId: BOOKING_ID },
};
const device = (id: string): PushDevice => ({
  id,
  platform: "android",
  token: `t-${id}`,
  webPush: null,
});

describe("fcmMessage", () => {
  it("is a visible notification with the ids as string data, for Android and iOS", () => {
    expect(fcmMessage("tok", message)).toEqual({
      token: "tok",
      notification: { title: message.title, body: message.body },
      data: { kind: "guest_arrived", bookingId: BOOKING_ID },
      android: { priority: "high", notification: { channelId: "default" } },
      apns: { payload: { aps: { sound: "default" } } },
    });
  });
});

describe("fcmPushSender", () => {
  it("maps FCM's answers: sent, invalid tokens, and failures worth retrying or not", async () => {
    const sendEach = vi.fn<FcmMessaging["sendEach"]>().mockResolvedValue({
      responses: [
        { success: true },
        { success: false, error: { code: "messaging/registration-token-not-registered" } },
        { success: false, error: { code: "messaging/invalid-registration-token" } },
        { success: false, error: { code: "messaging/server-unavailable" } },
        { success: false, error: { code: "messaging/invalid-argument" } },
      ],
    });
    const messaging: FcmMessaging = { sendEach };
    const outcomes = await fcmPushSender(messaging).send(
      ["a", "b", "c", "d", "e", "f"].map(device),
      message,
    );
    expect(outcomes).toEqual([
      { status: "sent" },
      { status: "invalid_token" },
      { status: "invalid_token" },
      { status: "failed", retryable: true, reason: "server-unavailable" },
      { status: "failed", retryable: false, reason: "invalid-argument" },
      { status: "failed", retryable: true, reason: "unknown-error" },
    ]);
    expect(sendEach.mock.calls[0]?.[0]).toHaveLength(6);
  });

  it("fails every device, retryably, when the request itself fails, and skips an empty list", async () => {
    const sendEach = vi
      .fn<FcmMessaging["sendEach"]>()
      .mockRejectedValueOnce(
        Object.assign(new Error("token t-a leaked"), { code: "app/network-error" }),
      )
      .mockRejectedValueOnce(new Error("boom"));
    const messaging: FcmMessaging = { sendEach };
    const sender = fcmPushSender(messaging);
    expect(await sender.send([device("a")], message)).toEqual([
      { status: "failed", retryable: true, reason: "app/network-error" },
    ]);
    expect(await sender.send([device("a")], message)).toEqual([
      { status: "failed", retryable: true, reason: "request failed" },
    ]);
    expect(await sender.send([], message)).toEqual([]);
    expect(sendEach).toHaveBeenCalledTimes(2);
  });
});
