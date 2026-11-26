import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  HttpProblem,
  problemResponses,
  problemSchema,
  registerProblemHandlers,
} from "./problem.ts";

function app() {
  const server = Fastify();
  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);
  registerProblemHandlers(server);
  const typed = server.withTypeProvider<ZodTypeProvider>();
  typed.get("/problem", () => {
    throw new HttpProblem(409, "cannot-publish", "Not yet", "Finish setup.", {
      reasons: [{ code: "no-availability", message: "Add a window." }],
    });
  });
  typed.get("/teapot", () => {
    throw Object.assign(new Error("short and stout"), { statusCode: 418 });
  });
  typed.get("/odd", () => {
    throw Object.assign(new Error("odd status"), { statusCode: 499 });
  });
  typed.get("/boom", () => {
    throw new Error("database password is hunter2");
  });
  typed.get(
    "/validated",
    { schema: { querystring: z.object({ n: z.coerce.number().int(), word: z.string().min(3) }) } },
    (request) => request.query,
  );
  return server;
}

describe("problem responses", () => {
  it("sends an HttpProblem as application/problem+json", async () => {
    const response = await app().inject({ method: "GET", url: "/problem?x=1" });
    expect(response.statusCode).toBe(409);
    expect(response.headers["content-type"]).toContain("application/problem+json");
    expect(response.json()).toEqual({
      type: "urn:nd:problem:cannot-publish",
      code: "cannot-publish",
      title: "Not yet",
      status: 409,
      detail: "Finish setup.",
      instance: "/problem",
      requestId: expect.any(String) as string,
      reasons: [{ code: "no-availability", message: "Add a window." }],
    });
  });

  it("lists each invalid input", async () => {
    const response = await app().inject({ method: "GET", url: "/validated?n=1.5&word=hi" });
    expect(response.statusCode).toBe(400);
    const body = response.json<{ code: string; errors: { path: string }[] }>();
    expect(body.code).toBe("invalid-request");
    expect(body.errors.map((error) => error.path).sort()).toEqual([
      "querystring.n",
      "querystring.word",
    ]);
  });

  it("keeps the status of other client errors", async () => {
    const response = await app().inject({ method: "GET", url: "/teapot" });
    expect(response.statusCode).toBe(418);
    expect(response.json()).toMatchObject({ code: "i-m-a-teapot", detail: "short and stout" });
    const odd = await app().inject({ method: "GET", url: "/odd" });
    expect(odd.json()).toMatchObject({ status: 499, title: "Request failed" });
  });

  it("hides the details of server errors", async () => {
    const response = await app().inject({ method: "GET", url: "/boom" });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("hunter2");
    expect(response.json()).toMatchObject({ code: "internal", title: "Something went wrong" });
  });

  it("answers unknown routes with 404", async () => {
    const response = await app().inject({ method: "GET", url: "/nowhere" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "not-found", instance: "/nowhere" });
  });
});

describe("problemResponses", () => {
  it("maps each status to the problem schema", () => {
    expect(problemResponses(401, 404)).toEqual({ 401: problemSchema, 404: problemSchema });
  });
});
