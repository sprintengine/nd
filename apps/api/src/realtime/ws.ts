import { parseClientMessage, REALTIME_PATH } from "@nd/domain";
import type { FastifyInstance, FastifyRequest, onRequestAsyncHookHandler } from "fastify";

import type { Auth } from "../auth/auth.ts";
import { sessionOf } from "../auth/session.ts";
import { HttpProblem } from "../http/problem.ts";
import type { RealtimeHub } from "./hub.ts";

// The realtime WebSocket. A browser or app connects with the Better Auth
// session cookie; the upgrade is refused (as an HTTP problem, before any
// WebSocket exists) without a session, from an origin the API does not
// trust, or when the user already holds too many connections.

export interface RealtimeRouteOptions {
  readonly hub: RealtimeHub;
  readonly auth: Auth;
  /** Origins trusted with cookies (CORS_ORIGINS). */
  readonly allowedOrigins: readonly string[];
  readonly maxConnectionsPerUser: number;
  readonly heartbeatSeconds: number;
}

/** Largest client frame accepted, in bytes; clients only ever send a ping. */
export const MAX_CLIENT_FRAME_BYTES = 1024;

export function registerRealtimeRoute(app: FastifyInstance, options: RealtimeRouteOptions): void {
  const { hub, auth, allowedOrigins } = options;

  /** Why an upgrade is refused, or undefined to accept it. */
  const refusal = (request: FastifyRequest): HttpProblem | undefined => {
    const origin = request.headers.origin;
    // Browsers always send Origin on a WebSocket upgrade; native apps may not.
    if (origin !== undefined && !allowedOrigins.includes(origin)) {
      return new HttpProblem(403, "origin-not-allowed", "This origin may not connect");
    }
    if (request.session === null) {
      return new HttpProblem(401, "unauthenticated", "Sign in to continue");
    }
    if (hub.count(request.session.userId) >= options.maxConnectionsPerUser) {
      return new HttpProblem(
        429,
        "too-many-connections",
        "Too many open connections",
        "Close another tab or device and try again.",
      );
    }
    return undefined;
  };
  const guard: onRequestAsyncHookHandler = (request) => {
    const problem = refusal(request);
    return problem === undefined ? Promise.resolve() : Promise.reject(problem);
  };

  app.get(
    REALTIME_PATH,
    { websocket: true, onRequest: guard, schema: { hide: true } },
    (socket, request) => {
      const { userId } = sessionOf(request);
      const cookie = request.headers.cookie ?? "";
      const validate = async () =>
        (await auth.api.getSession({ headers: new Headers({ cookie }) })) !== null;
      if (!hub.add(userId, socket, validate)) {
        socket.close(1008, "too many connections");
        return;
      }
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const text = Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.from(data as ArrayBuffer).toString("utf8");
        if (parseClientMessage(text)?.type === "ping") hub.sendTo(socket, { type: "pong" });
      });
      hub.sendTo(socket, { type: "ready", heartbeatSeconds: options.heartbeatSeconds });
    },
  );
}
