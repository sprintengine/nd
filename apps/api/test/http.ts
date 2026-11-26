import type { FastifyInstance, LightMyRequestResponse } from "fastify";

/** The Origin a browser on the web app sends. */
export const APP_ORIGIN = "http://localhost:5173";

/** `name=value` pairs from a response's Set-Cookie headers, as a Cookie header. */
export function cookiesFrom(response: LightMyRequestResponse): string {
  const header = response.headers["set-cookie"];
  const list = header === undefined ? [] : Array.isArray(header) ? header : [header];
  return list
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((pair) => !pair.endsWith("="))
    .join("; ");
}

/** Signs in with a magic link sent to `email`; returns the session cookie. */
export async function signIn(
  app: FastifyInstance,
  emails: readonly { to: string; text: string }[],
  email: string,
): Promise<string> {
  const sent = await app.inject({
    method: "POST",
    url: "/auth/sign-in/magic-link",
    headers: { origin: APP_ORIGIN },
    payload: { email },
  });
  if (sent.statusCode !== 200) throw new Error(`magic link not sent: ${sent.body}`);
  const link = magicLinkPath(emails, email);
  const verified = await app.inject({ method: "GET", url: link });
  const cookie = cookiesFrom(verified);
  if (cookie === "") throw new Error(`no session cookie: ${String(verified.statusCode)}`);
  return cookie;
}

/** Path and query of the newest magic link emailed to `email`. */
export function magicLinkPath(
  emails: readonly { to: string; text: string }[],
  email: string,
): string {
  const message = emails.findLast((candidate) => candidate.to === email);
  const match = message === undefined ? null : /https?:\/\/\S+/.exec(message.text);
  if (match === null) throw new Error(`no magic link for ${email}`);
  const url = new URL(match[0]);
  return `${url.pathname}${url.search}`;
}

/** Verifies a phone number for the signed-in user with the code texted to it. */
export async function verifyPhone(
  app: FastifyInstance,
  texts: readonly { to: string; body: string }[],
  cookie: string,
  phoneNumber: string,
): Promise<void> {
  const headers = { origin: APP_ORIGIN, cookie };
  const sent = await app.inject({
    method: "POST",
    url: "/auth/phone-number/send-otp",
    headers,
    payload: { phoneNumber },
  });
  if (sent.statusCode !== 200) throw new Error(`code not sent: ${sent.body}`);
  const code = /\d{6}/.exec(texts.findLast((text) => text.to === phoneNumber)?.body ?? "")?.[0];
  const verified = await app.inject({
    method: "POST",
    url: "/auth/phone-number/verify",
    headers,
    payload: { phoneNumber, code, updatePhoneNumber: true },
  });
  if (verified.statusCode !== 200) throw new Error(`phone not verified: ${verified.body}`);
}
