import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import {
  type ChargerControl,
  type ChargerControlCommand,
  chargerControlCommands,
  controlCommandPath,
} from "@nd/domain";

import { bearerMatches } from "./http-auth.ts";
import type { Logger } from "./logger.ts";

/** Largest command body accepted, in bytes. */
const MAX_BODY_BYTES = 16 * 1024;

const COMMAND_BY_PATH = new Map(
  (Object.keys(chargerControlCommands) as ChargerControlCommand[]).map((command) => [
    controlCommandPath(command),
    command,
  ]),
);

class BodyTooLarge extends Error {}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    // Past the limit the rest is read and dropped, so the 413 still reaches the caller.
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) {
        chunks.push(chunk);
      }
    });
    request.on("end", () => {
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLarge());
      } else {
        resolve(Buffer.concat(chunks).toString("utf8"));
      }
    });
    request.on("error", reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export interface ControlServerOptions {
  readonly control: ChargerControl;
  /** The shared secret callers send as `Authorization: Bearer <secret>`. */
  readonly secret: string;
  readonly logger: Logger;
}

/**
 * The internal ChargerControl endpoint: `POST /v1/commands/<command>` with a
 * JSON body, guarded by a shared bearer secret. It listens on its own port,
 * reachable only on the private network and never through the public proxy.
 */
export function createControlServer(options: ControlServerOptions): Server {
  const { control, secret, logger } = options;

  async function serve(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? "").split("?", 1)[0] ?? "";
    if (request.method === "GET" && path === "/healthz") {
      json(response, 200, { status: "ok" });
      return;
    }
    if (!bearerMatches(request.headers.authorization, secret)) {
      logger.warn({ path }, "control request with a missing or wrong secret");
      json(response, 401, { error: "unauthorized" });
      return;
    }
    const command = COMMAND_BY_PATH.get(path);
    if (command === undefined) {
      json(response, 404, { error: "not found" });
      return;
    }
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      json(response, 405, { error: "method not allowed" });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(request));
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        json(response, 413, { error: "body too large" });
      } else {
        json(response, 400, { error: "body must be JSON" });
      }
      return;
    }
    const parsed = chargerControlCommands[command].request.safeParse(body);
    if (!parsed.success) {
      json(response, 400, {
        error: "invalid request",
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String),
          message: issue.message,
        })),
      });
      return;
    }
    const run = control[command] as (request: unknown) => Promise<{ ok: boolean; reason?: string }>;
    const result = await run(parsed.data);
    logger.info(
      { command, chargeboxId: parsed.data.chargeboxId, ok: result.ok, reason: result.reason },
      "control command",
    );
    json(response, 200, result);
  }

  return createServer((request, response) => {
    serve(request, response).catch((error: unknown) => {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        "control request failed",
      );
      if (!response.headersSent) {
        json(response, 500, { error: "internal error" });
      } else {
        response.end();
      }
    });
  });
}
