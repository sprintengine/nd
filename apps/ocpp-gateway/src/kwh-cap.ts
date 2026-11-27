import type { ChargerConnection } from "./connection.ts";
import type { Logger } from "./logger.ts";
import type { GatewayStore } from "./store.ts";

export interface KwhCapGuardOptions {
  readonly connection: Pick<ChargerConnection, "afterReply" | "call">;
  readonly store: Pick<GatewayStore, "kwhCapReached">;
  readonly logger: Logger;
}

/**
 * Enforces a booking's kWh cap on one charger socket. After each MeterValues
 * for a booking session, it checks the energy delivered; once the cap is
 * reached it sends RemoteStopTransaction (after the reply is out), once per
 * transaction while the charger accepts it. A stop that is rejected or not
 * answered is sent again on the next MeterValues, and a new socket starts
 * afresh, so a reconnect re-checks too.
 */
export function kwhCapGuard(options: KwhCapGuardOptions) {
  const { connection, store, logger } = options;
  const stopping = new Set<number>();

  return {
    /** Checks the session after an inbound MeterValues CALL `messageId`. */
    async check(sessionId: string, messageId: string): Promise<void> {
      const reached = await store.kwhCapReached(sessionId);
      if (reached === undefined || stopping.has(reached.transactionId)) return;
      const { transactionId } = reached;
      stopping.add(transactionId);
      connection.afterReply(messageId, () => {
        void connection.call("RemoteStopTransaction", { transactionId }).then((result) => {
          const accepted = result.ok && result.response.status === "Accepted";
          if (!accepted) stopping.delete(transactionId);
          logger.info(
            {
              sessionId,
              transactionId,
              deliveredKwh: reached.deliveredKwh,
              kwhCap: reached.kwhCap,
              result: result.ok ? result.response.status : result.reason,
            },
            "stopping a session at its kWh cap",
          );
        });
      });
    },
  };
}
