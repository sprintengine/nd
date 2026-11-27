import type { Logger } from "./logger.ts";
import type { GatewayStore } from "./store.ts";

/** A charger is offline after this many heartbeat intervals without one. */
export const MISSED_HEARTBEATS = 3;

export interface HeartbeatMonitorOptions {
  readonly store: GatewayStore;
  readonly logger: Logger;
  readonly heartbeatIntervalSeconds: number;
  /** How often to look for silent chargers, in ms. */
  readonly checkEveryMs: number;
  readonly now?: () => Date;
}

export interface HeartbeatMonitor {
  /** Marks silent chargers offline now; resolves with how many. */
  check(): Promise<number>;
  stop(): void;
}

/**
 * Marks chargers `offline` when their last heartbeat is more than three
 * intervals old. It works from `chargers.last_heartbeat_at` alone, so a
 * restart of the gateway neither loses nor double-counts a gap. Checks once at
 * start, then every `checkEveryMs`.
 */
export function startHeartbeatMonitor(options: HeartbeatMonitorOptions): HeartbeatMonitor {
  const { store, logger } = options;
  const now = options.now ?? (() => new Date());
  const thresholdMs = MISSED_HEARTBEATS * options.heartbeatIntervalSeconds * 1000;
  let running: Promise<number> | undefined;

  const check = (): Promise<number> => {
    running ??= (async () => {
      try {
        const at = now();
        const count = await store.markStaleChargersOffline(
          new Date(at.getTime() - thresholdMs),
          at,
        );
        if (count > 0) {
          logger.warn({ count }, "chargers missed three heartbeats and are offline");
        }
        return count;
      } catch (error) {
        logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          "offline check failed",
        );
        return 0;
      } finally {
        running = undefined;
      }
    })();
    return running;
  };

  void check();
  const timer = setInterval(() => void check(), options.checkEveryMs);
  timer.unref();
  return {
    check,
    stop: () => {
      clearInterval(timer);
    },
  };
}
