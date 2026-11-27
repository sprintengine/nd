import { describe, expect, it } from "vitest";

import { createDb } from "./index.ts";

describe("createDb", () => {
  it("creates a handle without connecting", async () => {
    // Port 1 is never listening; this only passes because connections open lazily.
    const database = createDb("postgres://nobody:secret@127.0.0.1:1/none");
    expect(typeof database.db.execute).toBe("function");
    await database.close();
  });

  it("passes the pool size through", async () => {
    const database = createDb("postgres://nobody:secret@127.0.0.1:1/none", { max: 3 });
    expect(database.pool.options.max).toBe(3);
    await database.close();
  });
});
