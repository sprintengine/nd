import { EnvError } from "@nd/config";
import { describe, expect, it } from "vitest";

import { databaseUrlFromEnv } from "./env.ts";

describe("databaseUrlFromEnv", () => {
  it.each(["postgres://nd:nd@localhost:54320/nd", "postgresql://nd@db.example.com/nd"])(
    "accepts %s",
    (url) => {
      expect(databaseUrlFromEnv({ DATABASE_URL: url })).toBe(url);
    },
  );

  it.each([{}, { DATABASE_URL: "" }, { DATABASE_URL: "mysql://nd@localhost/nd" }])(
    "rejects %j",
    (source) => {
      expect(() => databaseUrlFromEnv(source)).toThrow(EnvError);
    },
  );
});
