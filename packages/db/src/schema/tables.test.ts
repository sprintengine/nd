import { getTableName, isTable } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as tables from "./tables.ts";

const allTables = Object.values(tables as Record<string, unknown>).filter(
  (value): value is PgTable => isTable(value),
);
const configs = allTables.map((table) => getTableConfig(table));

const foreignKeys = configs.flatMap((config) =>
  config.foreignKeys.map((foreignKey) => {
    const reference = foreignKey.reference();
    return {
      from: config.name,
      to: getTableName(reference.foreignTable),
      onDelete: foreignKey.onDelete ?? "no action",
    };
  }),
);

describe("schema", () => {
  it("defines every table of the data model", () => {
    expect(configs.map((config) => config.name).sort()).toEqual([
      "availability_rules",
      "bookings",
      "chargers",
      "device_tokens",
      "disputes",
      "hosts",
      "meter_values",
      "ocpp_messages",
      "payments",
      "reviews",
      "sessions",
      "stripe_webhook_events",
      "transfers",
      "users",
    ]);
  });

  it("cascades deletes only to availability rules and device tokens", () => {
    const cascading = foreignKeys.filter((foreignKey) => foreignKey.onDelete !== "no action");
    expect(cascading).toEqual([
      { from: "availability_rules", to: "chargers", onDelete: "cascade" },
      { from: "device_tokens", to: "users", onDelete: "cascade" },
    ]);
  });

  it("keeps sessions, meter values and OCPP messages when their parents go", () => {
    for (const from of ["sessions", "meter_values", "ocpp_messages", "payments", "transfers"]) {
      const keys = foreignKeys.filter((foreignKey) => foreignKey.from === from);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) expect(key.onDelete).toBe("no action");
    }
  });

  it("indexes OCPP messages by charger and time", () => {
    const config = getTableConfig(tables.ocppMessages);
    const index = config.indexes.find(
      (candidate) => candidate.config.name === "ocpp_messages_charger_ts_idx",
    );
    expect(index?.config.columns.map((column) => ("name" in column ? column.name : ""))).toEqual([
      "charger_id",
      "ts",
    ]);
  });

  it("gives charger locations a GiST index", () => {
    const config = getTableConfig(tables.chargers);
    const index = config.indexes.find(
      (candidate) => candidate.config.name === "chargers_location_gist",
    );
    expect(index?.config.method).toBe("gist");
  });

  it("matches Better Auth's core user fields", () => {
    const columns = Object.fromEntries(
      getTableConfig(tables.users).columns.map((column) => [column.name, column]),
    );
    expect(columns.id?.primary).toBe(true);
    expect(columns.id?.getSQLType()).toBe("text");
    expect(columns.email?.isUnique).toBe(true);
    for (const name of ["name", "email", "email_verified", "created_at", "updated_at"]) {
      expect(columns[name]?.notNull).toBe(true);
    }
    expect(columns.image?.notNull).toBe(false);
  });

  it("sets updated_at on every update", () => {
    const updatedAt = tables.bookings.updatedAt.onUpdateFn?.();
    expect(updatedAt).toBeInstanceOf(Date);
  });
});
