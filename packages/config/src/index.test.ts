import { describe, expect, it } from "vitest";
import { z } from "zod";

import { EnvError, parseEnv, port } from "./index.ts";

const schema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: port.default(3000),
});

describe("parseEnv", () => {
  it("applies defaults and coerces values", () => {
    expect(parseEnv(schema, {})).toEqual({ HOST: "0.0.0.0", PORT: 3000 });
    expect(parseEnv(schema, { PORT: "8080" })).toEqual({ HOST: "0.0.0.0", PORT: 8080 });
  });

  it("throws an EnvError that names the bad variable", () => {
    expect(() => parseEnv(schema, { PORT: "70000" })).toThrow(EnvError);
    expect(() => parseEnv(schema, { PORT: "not-a-port" })).toThrow(/PORT/);
  });
});
