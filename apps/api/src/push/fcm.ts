import { cert, initializeApp } from "firebase-admin/app";
import { getMessaging, type Message } from "firebase-admin/messaging";

import type { PushMessage, PushOutcome, PushSender } from "./push.ts";

// Firebase Cloud Messaging (HTTP v1) through firebase-admin. One FCM project
// reaches Android directly and iOS through APNs, so both platforms register
// FCM tokens. Error messages from FCM can echo the token, so only error codes
// are kept.

/** The part of firebase-admin's Messaging the sender uses. */
export interface FcmMessaging {
  sendEach(messages: Message[]): Promise<{
    responses: { success: boolean; error?: { code: string } }[];
  }>;
}

/** A Google service account key with FCM rights (the JSON file's fields). */
export interface FcmServiceAccount {
  readonly project_id: string;
  readonly client_email: string;
  readonly private_key: string;
}

/** Codes meaning the token will never work again: forget the device. */
const INVALID_TOKEN_CODES = new Set([
  "registration-token-not-registered",
  "invalid-registration-token",
]);

/** Codes worth trying again later. */
const RETRYABLE_CODES = new Set([
  "server-unavailable",
  "internal-error",
  "message-rate-exceeded",
  "device-message-rate-exceeded",
  "unknown-error",
]);

/** `messaging/registration-token-not-registered` → `registration-token-not-registered`. */
const bareCode = (code: string) => code.replace(/^messaging\//, "");

/** firebase-admin's messaging for a service account, in an app of its own. */
export function createFcmMessaging(account: FcmServiceAccount): FcmMessaging {
  const app = initializeApp(
    {
      credential: cert({
        projectId: account.project_id,
        clientEmail: account.client_email,
        privateKey: account.private_key,
      }),
      projectId: account.project_id,
    },
    "nd-push",
  );
  return getMessaging(app);
}

/** The FCM message for one device: a visible notification, with the ids as data. */
export function fcmMessage(token: string, message: PushMessage): Message {
  const data: Record<string, string> = {};
  for (const [key, value] of Object.entries(message.data)) {
    if (typeof value === "string") data[key] = value;
  }
  return {
    token,
    notification: { title: message.title, body: message.body },
    data,
    android: { priority: "high", notification: { channelId: "default" } },
    apns: { payload: { aps: { sound: "default" } } },
  };
}

/** Sends to iOS and Android devices through FCM. */
export function fcmPushSender(messaging: FcmMessaging): PushSender {
  return {
    name: "fcm",
    async send(devices, message) {
      if (devices.length === 0) return [];
      let batch;
      try {
        batch = await messaging.sendEach(
          devices.map((device) => fcmMessage(device.token, message)),
        );
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        const reason = typeof code === "string" ? bareCode(code) : "request failed";
        return devices.map(() => ({ status: "failed", retryable: true, reason }) as const);
      }
      return devices.map((_device, index): PushOutcome => {
        const response = batch.responses[index];
        if (response?.success === true) return { status: "sent" };
        const code = bareCode(response?.error?.code ?? "unknown-error");
        if (INVALID_TOKEN_CODES.has(code)) return { status: "invalid_token" };
        return { status: "failed", retryable: RETRYABLE_CODES.has(code), reason: code };
      });
    },
  };
}
