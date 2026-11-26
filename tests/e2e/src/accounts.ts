import { randomInt } from "node:crypto";

import { RUN_TAG } from "./config.ts";
import { ApiClient } from "./http.ts";
import { eventually } from "./wait.ts";

interface CapturedMessage {
  readonly channel: "email" | "sms";
  readonly to: string;
  readonly text: string;
}

/** Messages the stack's capture senders kept for `to` (GET /e2e/messages). */
async function messagesTo(to: string): Promise<CapturedMessage[]> {
  const reader = new ApiClient("e2e hooks");
  const { messages } = await reader.get<{ messages: CapturedMessage[] }>(
    `/e2e/messages?to=${encodeURIComponent(to)}`,
  );
  return messages;
}

/** The newest message to `to` matching `pattern`, once it has arrived; returns the match. */
async function awaitMessage(to: string, pattern: RegExp, after: number): Promise<RegExpExecArray> {
  return eventually(`a message to ${to}`, async () => {
    const messages = await messagesTo(to);
    for (const message of messages.slice(after).reverse()) {
      const match = pattern.exec(message.text);
      if (match !== null) return match;
    }
    return undefined;
  });
}

/** An Irish mobile number no other person in this run has. */
function phoneNumber(): string {
  return `+35387${String(randomInt(1_000_000, 9_999_999))}`;
}

export interface Person {
  readonly api: ApiClient;
  readonly userId: string;
  readonly email: string;
  readonly phone: string;
}

/**
 * Signs a new person up as the app would: a magic link to their email
 * (followed from the captured message), then their phone verified with the
 * code texted to it.
 */
export async function signUp(firstName: string): Promise<Person> {
  const api = new ApiClient(firstName);
  const email = `${firstName.toLowerCase()}.${RUN_TAG}.${String(randomInt(1e6))}@example.com`;

  const emailsBefore = (await messagesTo(email)).length;
  await api.post("/auth/sign-in/magic-link", { email, name: `${firstName} Tester` });
  const [link] = await awaitMessage(email, /https?:\/\/\S+/, emailsBefore);
  const url = new URL(link);
  const verified = await api.send("GET", `${url.pathname}${url.search}`);
  if (verified.status >= 400 || !api.cookie.includes("session_token")) {
    throw new Error(`${firstName}: the magic link did not sign in (${String(verified.status)})`);
  }

  const phone = phoneNumber();
  const textsBefore = (await messagesTo(phone)).length;
  await api.post("/auth/phone-number/send-otp", { phoneNumber: phone });
  const [, code] = await awaitMessage(phone, /\b(\d{6})\b/, textsBefore);
  await api.post("/auth/phone-number/verify", {
    phoneNumber: phone,
    code,
    updatePhoneNumber: true,
  });

  const me = await api.get<{ id: string; email: string; phoneVerified: boolean }>("/me");
  if (!me.phoneVerified || me.email !== email) {
    throw new Error(`${firstName}: signed up, but /me is ${JSON.stringify(me)}`);
  }
  return { api, userId: me.id, email, phone };
}
