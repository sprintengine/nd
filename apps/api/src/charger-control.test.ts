import { describe, expect, it } from "vitest";

import { unavailableChargerControl } from "./charger-control.ts";

describe("unavailableChargerControl", () => {
  it("answers 503 to every command until the gateway client is wired up", async () => {
    await expect(
      unavailableChargerControl.remoteStart("cb", { idTag: "T1" }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      unavailableChargerControl.remoteStop("cb", { transactionId: 1 }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      unavailableChargerControl.triggerMessage("cb", { message: "StatusNotification" }),
    ).rejects.toMatchObject({
      code: "charger-control-unavailable",
    });
  });
});
