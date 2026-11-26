import { describe, expect, it } from "vitest";

import { createDb } from "./index.ts";

describe("createDb", () => {
  it("creates a handle without connecting", async () => {
    // Port 1 is never listening; this only passes because connections open lazily.
    const database = createDb("postgres://nobody:secret@127.0.0.1:1/none");
    expect(typeof database.db.execute).toBe("function");
    await database.close();
  });
});
