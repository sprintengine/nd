import { Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createLogger } from "./logger.ts";

describe("createLogger", () => {
  it("writes JSON with secrets and idTags redacted", () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString("utf8"));
        done();
      },
    });
    const logger = createLogger({ level: "info", destination });
    logger.info({ idTag: "B123", headers: { authorization: "Basic xyz" }, secret: "s" }, "hello");
    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry).toMatchObject({
      msg: "hello",
      service: "ocpp-gateway",
      idTag: "[redacted]",
      secret: "[redacted]",
      headers: { authorization: "[redacted]" },
    });
  });

  it("defaults to info on stdout", () => {
    expect(createLogger().level).toBe("info");
  });
});
