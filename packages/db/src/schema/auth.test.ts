import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { authAccounts, authSessions, authVerifications } from "./auth.ts";

describe("auth schema", () => {
  it("uses auth_ table names, so Better Auth's sessions never clash with charging sessions", () => {
    expect(
      [authSessions, authAccounts, authVerifications].map((table) => getTableName(table)),
    ).toEqual(["auth_sessions", "auth_accounts", "auth_verifications"]);
  });

  it("removes sessions and linked accounts with their user", () => {
    for (const table of [authSessions, authAccounts]) {
      const [foreignKey] = getTableConfig(table).foreignKeys;
      expect(getTableName(foreignKey?.reference().foreignTable ?? authSessions)).toBe("users");
      expect(foreignKey?.onDelete).toBe("cascade");
    }
  });

  it("keeps session tokens unique", () => {
    expect(authSessions.token.isUnique).toBe(true);
  });
});
