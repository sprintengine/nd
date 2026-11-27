import { describe, expect, it, vi } from "vitest";

import type { ChargerConnection } from "./connection.ts";
import { ConnectionRegistry, REPLACED_CLOSE_CODE } from "./registry.ts";

const closes = new Map<ChargerConnection, ReturnType<typeof vi.fn>>();
const connection = (chargeboxId: string) => {
  const close = vi.fn();
  const created = {
    charger: { id: `id-${chargeboxId}`, chargeboxId },
    close,
  } as unknown as ChargerConnection;
  closes.set(created, close);
  return created;
};

describe("ConnectionRegistry", () => {
  it("keeps one connection per charger and closes the one it replaces", () => {
    const registry = new ConnectionRegistry();
    const first = connection("A");
    const second = connection("A");
    expect(registry.add(first)).toBeUndefined();
    expect(registry.add(connection("B"))).toBeUndefined();
    expect(registry.add(second)).toBe(first);
    expect(closes.get(first)).toHaveBeenCalledWith(
      REPLACED_CLOSE_CODE,
      "Replaced by a newer connection",
    );
    expect(registry.get("A")).toBe(second);
    expect(registry.size).toBe(2);
    expect(registry.add(second)).toBeUndefined();

    // The replaced socket closing later must not remove its successor.
    registry.remove(first);
    expect(registry.get("A")).toBe(second);
    registry.remove(second);
    expect(registry.get("A")).toBeUndefined();
    expect(registry.all().map((c) => c.charger.chargeboxId)).toEqual(["B"]);
  });
});
