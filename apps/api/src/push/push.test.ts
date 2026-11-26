import { describe, expect, it } from "vitest";

import { consolePushSender, type PushDevice, type PushSender, routedPushSender } from "./push.ts";

const message = {
  title: "Charger fault",
  body: "Your charger reported a fault.",
  data: { kind: "charger_faulted" as const },
};
const ios: PushDevice = { id: "d-ios", platform: "ios", token: "secret-ios", webPush: null };
const android: PushDevice = {
  id: "d-android",
  platform: "android",
  token: "secret-android",
  webPush: null,
};
const web: PushDevice = {
  id: "d-web",
  platform: "web",
  token: "https://push.example.com/secret",
  webPush: { p256dh: "key", auth: "auth" },
};

describe("consolePushSender", () => {
  it("writes the text without the token, or only that nothing was sent when redacting", async () => {
    const lines: string[] = [];
    const sender = consolePushSender({ sink: (line) => lines.push(line) });
    expect(await sender.send([ios], message)).toEqual([{ status: "sent" }]);
    expect(lines).toEqual([
      "[push] to ios device d-ios: Charger fault: Your charger reported a fault.",
    ]);
    lines.length = 0;
    await consolePushSender({ redact: true, sink: (line) => lines.push(line) }).send(
      [web],
      message,
    );
    expect(lines[0]).toBe("[push] not sent to web device d-web: no push provider is configured");
    expect(lines.join()).not.toContain("secret");
  });
});

describe("routedPushSender", () => {
  const recording = (name: string) => {
    const seen: string[] = [];
    const sender: PushSender = {
      name,
      send: (devices) => {
        seen.push(...devices.map((device) => device.id));
        return Promise.resolve(devices.map(() => ({ status: "sent" }) as const));
      },
    };
    return { sender, seen };
  };

  it("sends iOS and Android through the mobile provider and the web through web push, in order", async () => {
    const mobile = recording("fcm");
    const webPush = recording("web-push");
    const sender = routedPushSender({ mobile: mobile.sender, web: webPush.sender });
    expect(sender.name).toBe("fcm+web-push");
    expect(await sender.send([web, ios, android], message)).toEqual([
      { status: "sent" },
      { status: "sent" },
      { status: "sent" },
    ]);
    expect(mobile.seen).toEqual(["d-ios", "d-android"]);
    expect(webPush.seen).toEqual(["d-web"]);
  });

  it("fails devices with no provider, and fills in outcomes a provider left out", async () => {
    const short: PushSender = { name: "short", send: () => Promise.resolve([]) };
    const sender = routedPushSender({ mobile: short, web: undefined });
    expect(await sender.send([ios, web], message)).toEqual([
      { status: "failed", retryable: true, reason: "no outcome from provider" },
      { status: "failed", retryable: false, reason: "no provider for this platform" },
    ]);
  });
});
