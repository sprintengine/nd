import webPush from "web-push";

import type { PushDevice, PushMessage, PushOutcome, PushSender } from "./push.ts";

// Web push (RFC 8030) with VAPID through the `web-push` library, for the web
// app's service worker. The payload is encrypted to the subscription's keys.
// The push service's error body can echo the endpoint, so only its status is kept.

/** The application server keys and contact the push services see. */
export interface VapidKeys {
  /** `mailto:` address or https URL of the operator. */
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

/** How a push is handed to a push service; `web-push`'s `sendNotification` fits. */
export type WebPushSend = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  options: {
    vapidDetails: { subject: string; publicKey: string; privateKey: string };
    TTL: number;
    urgency: "high";
    timeout: number;
  },
) => Promise<unknown>;

/** A push waits this long for an offline browser before the service drops it. */
const TTL_SECONDS = 24 * 3600;
const TIMEOUT_MS = 10_000;

/** What the web app's service worker receives. */
export function webPushPayload(message: PushMessage): string {
  return JSON.stringify({ title: message.title, body: message.body, data: message.data });
}

function outcomeOf(error: unknown): PushOutcome {
  const status = (error as { statusCode?: unknown }).statusCode;
  if (typeof status !== "number") {
    return { status: "failed", retryable: true, reason: "request failed" };
  }
  // 404 and 410: the subscription expired or was unsubscribed.
  if (status === 404 || status === 410) return { status: "invalid_token" };
  return {
    status: "failed",
    retryable: status === 429 || status >= 500,
    reason: `push service answered ${String(status)}`,
  };
}

/** Sends to web push subscriptions. */
export function webPushSender(
  vapid: VapidKeys,
  send: WebPushSend = webPush.sendNotification,
): PushSender {
  const options = {
    vapidDetails: {
      subject: vapid.subject,
      publicKey: vapid.publicKey,
      privateKey: vapid.privateKey,
    },
    TTL: TTL_SECONDS,
    urgency: "high" as const,
    timeout: TIMEOUT_MS,
  };
  const sendOne = async (device: PushDevice, payload: string): Promise<PushOutcome> => {
    if (device.webPush === null) {
      return { status: "failed", retryable: false, reason: "subscription has no keys" };
    }
    try {
      await send({ endpoint: device.token, keys: device.webPush }, payload, options);
      return { status: "sent" };
    } catch (error) {
      return outcomeOf(error);
    }
  };
  return {
    name: "web-push",
    send(devices, message) {
      const payload = webPushPayload(message);
      return Promise.all(devices.map((device) => sendOne(device, payload)));
    },
  };
}
