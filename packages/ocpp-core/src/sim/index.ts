/**
 * A simulated myenergi Zappi speaking OCPP 1.6J, for testing a central
 * system without hardware. See {@link startZappiSim}.
 */

import { ZappiSim, type ZappiSimOptions } from "./zappi.ts";

export * from "./config.ts";
export * from "./zappi.ts";

/**
 * Creates a simulated Zappi, connects it and waits for the answer to its
 * BootNotification. Pass `connect: false` to get it unconnected.
 *
 * ```ts
 * const sim = await startZappiSim({ url: "ws://localhost:9000/v16/", chargeboxId: "21234567", secret });
 * sim.plugIn();
 * await sim.waitForStatus("Preparing");
 * await sim.stop();
 * ```
 */
export async function startZappiSim(
  options: ZappiSimOptions & { connect?: boolean },
): Promise<ZappiSim> {
  const sim = new ZappiSim(options);
  if (options.connect !== false) {
    try {
      await sim.connect();
    } catch (error) {
      await sim.stop();
      throw error;
    }
  }
  return sim;
}
