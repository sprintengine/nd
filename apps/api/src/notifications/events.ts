import { offlineChargers } from "../data/notifications.ts";
import type { ChargerSignal } from "../events/charger-events.ts";
import type { Services } from "../services.ts";
import { queueNotification } from "./queue.ts";
import { offlineAlertAt, triggersForChargerEvent } from "./triggers.ts";

/** Turns charger events into queued notifications. Only queues jobs, so it is quick. */
export interface NotificationEventHandler {
  handle(signal: ChargerSignal): Promise<void>;
}

/**
 * Queues notifications for charger events: session start and stop, faults,
 * and offline alerts (checked again when they run). After the event
 * connection comes back, offline chargers are queued again, since their
 * event may have been missed; the ledger keeps each spell to one alert.
 * Registered on the shared all-chargers subscription in `app.ts`.
 */
export function notificationEventHandler(
  services: Pick<Services, "db" | "clock" | "jobs" | "log">,
): NotificationEventHandler {
  return {
    async handle(signal) {
      if (signal.kind === "resync") {
        const now = services.clock.now();
        for (const charger of await offlineChargers(services.db)) {
          const due =
            charger.lastHeartbeatAt === null ? now : offlineAlertAt(charger.lastHeartbeatAt);
          await queueNotification(
            services,
            {
              type: "charger_offline",
              chargerId: charger.id,
              lastHeartbeatAt: charger.lastHeartbeatAt?.toISOString() ?? null,
            },
            due.getTime() > now.getTime() ? due : undefined,
          );
        }
        return;
      }
      for (const { trigger, startAfter } of triggersForChargerEvent(signal.event)) {
        await queueNotification(services, trigger, startAfter);
      }
    },
  };
}
