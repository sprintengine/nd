import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { accountDeletions, hostTaxDetails } from "./accounts.ts";

describe("accounts schema", () => {
  it("keeps tax details and deletion requests when their parents go", () => {
    for (const [table, parent] of [
      [hostTaxDetails, "hosts"],
      [accountDeletions, "users"],
    ] as const) {
      const [foreignKey] = getTableConfig(table).foreignKeys;
      expect(getTableName(foreignKey?.reference().foreignTable ?? table)).toBe(parent);
      expect(foreignKey?.onDelete ?? "no action").toBe("no action");
    }
  });

  it("allows one pending deletion per user", () => {
    const index = getTableConfig(accountDeletions).indexes.find(
      (candidate) => candidate.config.name === "account_deletions_one_pending_per_user",
    );
    expect(index?.config.unique).toBe(true);
    expect(index?.config.where).toBeDefined();
  });

  it("stores only encrypted and masked forms of the TIN", () => {
    const columns = getTableConfig(hostTaxDetails).columns.map((column) => column.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "tin_encrypted",
        "tin_masked",
        "date_of_birth_encrypted",
        "encryption_key_id",
      ]),
    );
    expect(columns).not.toContain("tin");
    expect(columns).not.toContain("date_of_birth");
  });

  it("sets updated_at on every update", () => {
    expect(hostTaxDetails.updatedAt.onUpdateFn?.()).toBeInstanceOf(Date);
  });
});
