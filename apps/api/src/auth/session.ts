import type { FastifyInstance, FastifyRequest, onRequestAsyncHookHandler } from "fastify";

import { HttpProblem } from "../http/problem.ts";
import { type Auth, AUTH_BASE_PATH } from "./auth.ts";

/** The signed-in user behind a request. */
export interface SessionUser {
  readonly userId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly phoneVerified: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    /** The signed-in user, or null. Set by the session hook. */
    session: SessionUser | null;
  }
}

function headersOf(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

/**
 * The one hook that reads the Better Auth session cookie on every API
 * route (Better Auth's own routes excepted). It runs on request, before body
 * validation, so a caller without access gets 401 or 403, never a 400. It
 * renews a sliding session and passes the refreshed cookie on to the response.
 */
export function registerSession(app: FastifyInstance, auth: Auth): void {
  app.decorateRequest("session", null);
  app.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith(`${AUTH_BASE_PATH}/`) || request.headers.cookie === undefined) {
      return;
    }
    const { headers, response } = await auth.api.getSession({
      headers: headersOf(request),
      returnHeaders: true,
    });
    const cookies = headers.getSetCookie();
    if (cookies.length > 0) reply.header("set-cookie", cookies);
    if (response === null) return;
    request.session = {
      userId: response.user.id,
      sessionId: response.session.id,
      email: response.user.email,
      phoneVerified: response.user.phoneNumberVerified === true,
    };
  });
}

const unauthenticated = () => new HttpProblem(401, "unauthenticated", "Sign in to continue");

/** The signed-in user, or a 401 problem. */
export function sessionOf(request: FastifyRequest): SessionUser {
  if (request.session === null) throw unauthenticated();
  return request.session;
}

/** Route guard: answers 401 without a session. */
export const requireUser: onRequestAsyncHookHandler = (request) =>
  request.session === null ? Promise.reject(unauthenticated()) : Promise.resolve();

/** Route guard: 401 without a session, 403 until the user has verified a phone number. */
export const requireVerifiedPhone: onRequestAsyncHookHandler = (request) => {
  if (request.session === null) return Promise.reject(unauthenticated());
  if (!request.session.phoneVerified) {
    return Promise.reject(
      new HttpProblem(
        403,
        "phone-verification-required",
        "Verify your phone number first",
        "Booking and hosting need a verified phone number.",
      ),
    );
  }
  return Promise.resolve();
};
