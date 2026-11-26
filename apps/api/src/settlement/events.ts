import type { ChargerSignal } from "../events/charger-events.ts";
import { reconcileSessionJob, settlementSweepJob } from "./jobs.ts";
import type { SettlementServices } from "./services.ts";

/** Reacts to charger events for settlement. Only queues jobs, so it is quick and safe to repeat. */
export interface SettlementEventHandler {
  handle(signal: ChargerSignal): Promise<void>;
}

/**
 * Queues reconciliation when the gateway reports a session stopped, and a
 * sweep after the event connection comes back (events may have been missed).
 * Registered on the shared all-chargers subscription in `app.ts`.
 */
export function settlementEventHandler(services: SettlementServices): SettlementEventHandler {
  return {
    async handle(signal) {
      if (signal.kind === "resync") {
        await services.jobs.send(settlementSweepJob, {});
        return;
      }
      if (signal.event.type !== "session_stopped") return;
      const { sessionId } = signal.event;
      await services.jobs.send(reconcileSessionJob, { sessionId }, { singletonKey: sessionId });
    },
  };
}
