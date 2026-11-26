import { z } from "zod";

import { pruneNotifications } from "../data/notifications.ts";
import { type AnyJob, defineJob } from "../jobs/jobs.ts";
import { deliverNotifications, type NotificationServices } from "./deliver.ts";
import { notificationTriggerSchema } from "./triggers.ts";

/** Sent-notification records are kept this long, then deleted. */
const LEDGER_RETENTION_DAYS = 90;

/** Pushes the notifications one trigger leads to; keyed by the trigger's event. */
export const notifyJob = defineJob({
  name: "notify",
  payload: notificationTriggerSchema,
  retry: { limit: 5, delaySeconds: 30, backoff: true, maxDelaySeconds: 1800 },
  timeoutSeconds: 60,
  run: async (trigger, services: NotificationServices) => {
    await deliverNotifications(services, trigger);
  },
});

/** Daily: forgets sent-notification records older than 90 days. */
export const notificationsPruneJob = defineJob({
  name: "notifications-prune",
  payload: z.object({}),
  retry: { limit: 3, delaySeconds: 300, backoff: true, maxDelaySeconds: 3600 },
  cron: "30 4 * * *",
  run: async (_payload, services: NotificationServices) => {
    const before = new Date(services.clock.now().getTime() - LEDGER_RETENTION_DAYS * 86_400_000);
    const removed = await pruneNotifications(services.db, before);
    services.log.info({ removed }, "old notification records pruned");
  },
});

/** Every notification job the API runs. */
export const NOTIFICATION_JOBS: readonly AnyJob<NotificationServices>[] = [
  notifyJob,
  notificationsPruneJob,
];
