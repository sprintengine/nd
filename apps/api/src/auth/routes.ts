import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { PROBLEM_CONTENT_TYPE, problemFor } from "../http/problem.ts";
import { type Auth, AUTH_BASE_PATH, CLIENT_IP_HEADER } from "./auth.ts";

/** Copies a Fastify request into a Fetch `Request` for Better Auth. */
export function toWebRequest(request: FastifyRequest, baseUrl: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || name === CLIENT_IP_HEADER) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  headers.set(CLIENT_IP_HEADER, request.ip);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  const body = hasBody && Buffer.isBuffer(request.body) ? new Uint8Array(request.body) : undefined;
  return new Request(new URL(request.url, baseUrl), {
    method: request.method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

interface BetterAuthErrorBody {
  message?: unknown;
  code?: unknown;
}

/**
 * Sends Better Auth's response. Its JSON errors are rewritten as problem
 * documents that keep Better Auth's `code` (e.g. `INVALID_TOKEN`) and
 * `message`, so Better Auth's client still reads them.
 */
export async function sendWebResponse(
  request: FastifyRequest,
  reply: FastifyReply,
  response: Response,
): Promise<FastifyReply> {
  reply.code(response.status);
  for (const [name, value] of response.headers) {
    if (name === "set-cookie" || name === "content-length") continue;
    reply.header(name, value);
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) reply.header("set-cookie", cookies);

  const text = await response.text();
  const isJson = response.headers.get("content-type")?.includes("application/json") === true;
  if (response.status >= 400 && isJson) {
    let parsed: BetterAuthErrorBody = {};
    try {
      parsed = JSON.parse(text) as BetterAuthErrorBody;
    } catch {
      // Not JSON after all: fall through with an empty body.
    }
    const message = typeof parsed.message === "string" ? parsed.message : undefined;
    const code = typeof parsed.code === "string" ? parsed.code : "AUTH_ERROR";
    const problem = problemFor(
      request,
      response.status,
      code,
      response.statusText || "Authentication failed",
      message,
    );
    return reply.type(PROBLEM_CONTENT_TYPE).send({ ...problem, message });
  }
  return text === "" ? reply.send() : reply.send(text);
}

/**
 * Mounts Better Auth at `/auth/*`. Request bodies reach it unparsed, so it
 * sees JSON and the form posts some OAuth providers send exactly as sent.
 */
export function registerAuthRoutes(app: FastifyInstance, auth: Auth, baseUrl: string): void {
  void app.register((scope, _options, done) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, parsed) => {
      parsed(null, body);
    });
    scope.route({
      method: ["GET", "POST"],
      url: `${AUTH_BASE_PATH}/*`,
      schema: { hide: true },
      handler: async (request, reply) =>
        sendWebResponse(request, reply, await auth.handler(toWebRequest(request, baseUrl))),
    });
    done();
  });
}
