import { STATUS_CODES } from "node:http";

import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { z } from "zod";

/** Media type of every error response (RFC 9457). */
export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** Prefix of the `type` URI of every problem; the rest is the stable `code`. */
const PROBLEM_TYPE_PREFIX = "urn:nd:problem:";

/** The body of every error response the API sends. */
export const problemSchema = z
  .object({
    type: z.string().describe("URI naming the kind of problem: `urn:nd:problem:<code>`"),
    code: z.string().describe("Stable, machine-readable problem code"),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string().describe("Path of the request that failed"),
    requestId: z.string(),
    errors: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .optional()
      .describe("Each invalid input, for validation errors"),
    reasons: z
      .array(z.object({ code: z.string(), message: z.string() }))
      .optional()
      .describe("Each unmet condition, when an action is not allowed yet"),
  })
  .meta({ id: "Problem" });

export type Problem = z.infer<typeof problemSchema>;

type ProblemExtras = Pick<Problem, "errors" | "reasons">;

/** Throw from a handler to answer with a problem document. */
export class HttpProblem extends Error {
  override name = "HttpProblem";
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly extras: ProblemExtras;

  constructor(
    status: number,
    code: string,
    title: string,
    detail?: string,
    extras: ProblemExtras = {},
  ) {
    super(detail ?? title);
    this.status = status;
    this.code = code;
    this.title = title;
    this.detail = detail;
    this.extras = extras;
  }
}

/** Builds a problem body for a request. */
export function problemFor(
  request: FastifyRequest,
  status: number,
  code: string,
  title: string,
  detail?: string,
  extras: ProblemExtras = {},
): Problem {
  return {
    type: `${PROBLEM_TYPE_PREFIX}${code}`,
    code,
    title,
    status,
    ...(detail === undefined ? {} : { detail }),
    instance: request.url.split("?")[0] ?? request.url,
    requestId: request.id,
    ...extras,
  };
}

/** Sends a problem document. */
export function sendProblem(reply: FastifyReply, problem: Problem): FastifyReply {
  return reply.code(problem.status).type(PROBLEM_CONTENT_TYPE).send(problem);
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function statusOf(error: FastifyError): number {
  const status = error.statusCode;
  return typeof status === "number" && status >= 400 && status <= 599 ? status : 500;
}

/** Answers every error and unknown route with a problem document. */
export function registerProblemHandlers(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof HttpProblem) {
      return sendProblem(
        reply,
        problemFor(request, error.status, error.code, error.title, error.detail, error.extras),
      );
    }
    if (hasZodFastifySchemaValidationErrors(error)) {
      const errors = error.validation.map((issue) => ({
        path: [error.validationContext, ...issue.instancePath.split("/").filter(Boolean)].join("."),
        message: issue.message ?? "is invalid",
      }));
      return sendProblem(
        reply,
        problemFor(request, 400, "invalid-request", "The request is not valid", undefined, {
          errors,
        }),
      );
    }
    const status = statusOf(error);
    if (status >= 500) {
      request.log.error({ err: error }, "request failed");
      return sendProblem(reply, problemFor(request, status, "internal", "Something went wrong"));
    }
    const title = STATUS_CODES[status] ?? "Request failed";
    return sendProblem(reply, problemFor(request, status, slug(title), title, error.message));
  });

  app.setNotFoundHandler((request, reply) =>
    sendProblem(
      reply,
      problemFor(request, 404, "not-found", "Not Found", "No route matches this request"),
    ),
  );
}

/** Problem responses for a route's OpenAPI schema. */
export function problemResponses<const S extends readonly number[]>(
  ...statuses: S
): Record<S[number], typeof problemSchema> {
  return Object.fromEntries(statuses.map((status) => [status, problemSchema])) as Record<
    S[number],
    typeof problemSchema
  >;
}
