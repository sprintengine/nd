import type { Services } from "../services.ts";
import { notifyJob } from "./jobs.ts";
import { eventKeyOf, type NotificationTrigger } from "./triggers.ts";

/**
 * Queues the `notify` job for a trigger, keyed by its event so a repeat is a
 * no-op. Never throws: the change that caused it is already saved, and a
 * lost notification must not fail it, so a failure to queue is only logged.
 */
export async function queueNotification(
  services: Pick<Services, "jobs" | "log">,
  trigger: NotificationTrigger,
  startAfter?: Date,
): Promise<void> {
  try {
    await services.jobs.send(notifyJob, trigger, {
      singletonKey: eventKeyOf(trigger),
      ...(startAfter === undefined ? {} : { startAfter }),
    });
  } catch (error) {
    services.log.warn({ notification: trigger.type, err: error }, "queueing a notification failed");
  }
}
