import {
  CHARGER_FAULT_ALERT_COOLDOWN_MINUTES,
  notificationAllowed,
  type NotificationPreferences,
} from "@nd/domain";

import {
  chargerForAlert,
  claimNotification,
  devicesOf,
  markDelivered,
  notificationBooking,
  notificationSession,
  notifiedSince,
  preferencesOf,
  removeDevices,
  settledAmounts,
} from "../data/notifications.ts";
import type { PushSender } from "../push/push.ts";
import type { Services } from "../services.ts";
import {
  type NotificationFacts,
  offlineSpellContinues,
  type PlannedNotification,
  planNotifications,
} from "./rules.ts";
import { faultKeyPrefix, type NotificationTrigger } from "./triggers.ts";

// The `notify` job: load what the trigger is about, plan who hears what,
// skip what their preferences turn off or what was already delivered, and
// push to each recipient's devices. Tokens a provider reports invalid are
// forgotten. A provider failure worth retrying fails the job, and the retry
// sends only what has not been delivered.

/** What sending notifications needs. */
export interface NotificationServices extends Services {
  readonly push: PushSender;
}

/** A push to every device failed in a way worth retrying. */
export class PushRetryError extends Error {
  override name = "PushRetryError";
}

const MINUTE_MS = 60_000;

/** Loads the facts the trigger's notifications draw on; undefined when there is nothing to tell. */
async function loadFacts(
  services: NotificationServices,
  trigger: NotificationTrigger,
): Promise<NotificationFacts | undefined> {
  const { db } = services;
  if (trigger.type === "charger_faulted" || trigger.type === "charger_offline") {
    const charger = await chargerForAlert(db, trigger.chargerId);
    if (charger === undefined) return undefined;
    if (
      trigger.type === "charger_offline" &&
      !offlineSpellContinues(trigger.lastHeartbeatAt, charger)
    ) {
      return undefined;
    }
    return { chargerHostUserId: charger.hostUserId };
  }
  const booking = await notificationBooking(db, trigger.bookingId);
  if (booking === undefined) return undefined;
  if (!("sessionId" in trigger)) return { booking };
  const session = await notificationSession(db, trigger.sessionId);
  if (session === undefined) return undefined;
  const settled =
    trigger.type === "session_settled" || trigger.type === "session_ended"
      ? await settledAmounts(db, booking.id)
      : undefined;
  return { booking, kwh: session.kwh, failureReason: session.stopReason, settled };
}

/** Whether the host was told about another fault of this charger within the cooldown. */
function faultCoolingDown(
  services: NotificationServices,
  trigger: NotificationTrigger,
  planned: PlannedNotification,
): Promise<boolean> {
  if (trigger.type !== "charger_faulted") return Promise.resolve(false);
  const since = new Date(
    services.clock.now().getTime() - CHARGER_FAULT_ALERT_COOLDOWN_MINUTES * MINUTE_MS,
  );
  return notifiedSince(
    services.db,
    planned.userId,
    faultKeyPrefix(trigger.chargerId),
    since,
    planned.eventKey,
  );
}

/** What became of one notification. */
export type DeliveryResult =
  | "delivered"
  | "no_devices"
  | "already_delivered"
  | "turned_off"
  | "cooling_down"
  | "undeliverable"
  | "retry";

/** Sends one planned notification. */
async function deliverOne(
  services: NotificationServices,
  trigger: NotificationTrigger,
  planned: PlannedNotification,
  preferences: NotificationPreferences,
): Promise<DeliveryResult> {
  const { db, clock, push, log } = services;
  if (!notificationAllowed(planned.kind, preferences)) return "turned_off";
  if (await faultCoolingDown(services, trigger, planned)) return "cooling_down";
  const ledgerId = await claimNotification(db, {
    userId: planned.userId,
    kind: planned.kind,
    eventKey: planned.eventKey,
  });
  if (ledgerId === undefined) return "already_delivered";
  const devices = await devicesOf(db, planned.userId);
  if (devices.length === 0) {
    await markDelivered(db, ledgerId, clock.now());
    return "no_devices";
  }
  const outcomes = await push.send(devices, planned.message);
  const invalid = devices.filter((_device, index) => outcomes[index]?.status === "invalid_token");
  await removeDevices(
    db,
    invalid.map((device) => device.id),
  );
  const sent = outcomes.some((outcome) => outcome.status === "sent");
  const failures = outcomes.flatMap((outcome) => (outcome.status === "failed" ? [outcome] : []));
  if (failures.length > 0 || invalid.length > 0) {
    // Ids and reasons only: tokens and text stay out of the log.
    log.warn(
      {
        notification: planned.kind,
        provider: push.name,
        invalidTokens: invalid.length,
        failed: failures.length,
        reasons: [...new Set(failures.map((failure) => failure.reason))],
      },
      "some pushes were not delivered",
    );
  }
  if (!sent && failures.some((failure) => failure.retryable)) return "retry";
  await markDelivered(db, ledgerId, clock.now());
  return sent ? "delivered" : "undeliverable";
}

/**
 * Sends the notifications a trigger leads to, once per recipient. Throws
 * {@link PushRetryError} when a recipient's devices all failed in a way worth
 * retrying, after trying every recipient.
 */
export async function deliverNotifications(
  services: NotificationServices,
  trigger: NotificationTrigger,
): Promise<DeliveryResult[]> {
  const facts = await loadFacts(services, trigger);
  if (facts === undefined) return [];
  const results: DeliveryResult[] = [];
  for (const planned of planNotifications(trigger, facts)) {
    const preferences = await preferencesOf(services.db, planned.userId);
    results.push(await deliverOne(services, trigger, planned, preferences));
  }
  if (results.includes("retry")) {
    throw new PushRetryError(`push providers failed for ${trigger.type}; will retry`);
  }
  return results;
}
