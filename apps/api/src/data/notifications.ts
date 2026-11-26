import {
  bookings,
  chargers,
  deviceTokens,
  type Executor,
  hosts,
  notificationPreferences,
  notifications,
  payments,
  sessions,
} from "@nd/db";
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type DevicePlatform,
  type NotificationPreferences,
} from "@nd/domain";
import { and, asc, eq, gt, inArray, isNull, like, lt, ne, notInArray, sql } from "drizzle-orm";

import type { PushDevice } from "../push/push.ts";

// Reads and writes behind push notifications: devices, preferences, the
// ledger that makes each notification go out once, and what a notification
// says. Integration tests cover them against Postgres; unit tests mock this module.

/** A user keeps at most this many devices; registering another forgets the least recently seen. */
export const MAX_DEVICES_PER_USER = 10;

export interface DeviceRegistration {
  readonly platform: DevicePlatform;
  readonly token: string;
  readonly webPush: { readonly p256dh: string; readonly auth: string } | null;
}

/**
 * Registers a device for `userId`. A token already known (from this user or
 * another account signed in on the same device) is moved to this user and
 * refreshed rather than duplicated. Resolves to its id and whether it is new.
 */
export async function registerDevice(
  db: Executor,
  userId: string,
  device: DeviceRegistration,
  now: Date,
): Promise<{ id: string; created: boolean; createdAt: Date }> {
  const values = {
    userId,
    platform: device.platform,
    token: device.token,
    webPushP256dh: device.webPush?.p256dh ?? null,
    webPushAuth: device.webPush?.auth ?? null,
    lastSeenAt: now,
  };
  const [row] = await db
    .insert(deviceTokens)
    .values(values)
    .onConflictDoUpdate({
      target: deviceTokens.token,
      set: {
        userId: values.userId,
        platform: values.platform,
        webPushP256dh: values.webPushP256dh,
        webPushAuth: values.webPushAuth,
        lastSeenAt: values.lastSeenAt,
      },
    })
    .returning({
      id: deviceTokens.id,
      createdAt: deviceTokens.createdAt,
      // xmax is 0 only for a row this statement inserted.
      created: sql<boolean>`(xmax = 0)`,
    });
  if (row === undefined) throw new Error("device not saved");
  const keep = db
    .select({ id: deviceTokens.id })
    .from(deviceTokens)
    .where(eq(deviceTokens.userId, userId))
    .orderBy(sql`${deviceTokens.lastSeenAt} desc`, sql`${deviceTokens.id} desc`)
    .limit(MAX_DEVICES_PER_USER);
  await db
    .delete(deviceTokens)
    .where(and(eq(deviceTokens.userId, userId), notInArray(deviceTokens.id, keep)));
  return row;
}

/** Forgets one of the user's devices. Resolves to whether it existed. */
export async function deleteDevice(
  db: Executor,
  userId: string,
  deviceId: string,
): Promise<boolean> {
  const removed = await db
    .delete(deviceTokens)
    .where(and(eq(deviceTokens.id, deviceId), eq(deviceTokens.userId, userId)))
    .returning({ id: deviceTokens.id });
  return removed.length > 0;
}

/** The user's devices, as push targets. */
export async function devicesOf(db: Executor, userId: string): Promise<PushDevice[]> {
  const rows = await db
    .select()
    .from(deviceTokens)
    .where(eq(deviceTokens.userId, userId))
    .orderBy(asc(deviceTokens.createdAt));
  return rows.map((row) => ({
    id: row.id,
    platform: row.platform,
    token: row.token,
    webPush:
      row.webPushP256dh === null || row.webPushAuth === null
        ? null
        : { p256dh: row.webPushP256dh, auth: row.webPushAuth },
  }));
}

/** Forgets devices whose tokens a provider reported invalid. */
export async function removeDevices(db: Executor, deviceIds: readonly string[]): Promise<void> {
  if (deviceIds.length === 0) return;
  await db.delete(deviceTokens).where(inArray(deviceTokens.id, [...deviceIds]));
}

/** The user's switches; every one on when they never changed any. */
export async function preferencesOf(
  db: Executor,
  userId: string,
): Promise<NotificationPreferences> {
  const [row] = await db
    .select()
    .from(notificationPreferences)
    .where(eq(notificationPreferences.userId, userId))
    .limit(1);
  if (row === undefined) return DEFAULT_NOTIFICATION_PREFERENCES;
  return {
    bookingRequests: row.bookingRequests,
    guestArrivals: row.guestArrivals,
    sessionUpdates: row.sessionUpdates,
    chargerAlerts: row.chargerAlerts,
    bookingUpdates: row.bookingUpdates,
    chargingUpdates: row.chargingUpdates,
  };
}

/** Changes the switches sent, creating the user's row on first use. Resolves to all of them. */
export async function savePreferences(
  db: Executor,
  userId: string,
  patch: Partial<NotificationPreferences>,
): Promise<NotificationPreferences> {
  await db
    .insert(notificationPreferences)
    .values({ userId, ...patch })
    .onConflictDoUpdate({ target: notificationPreferences.userId, set: { ...patch } });
  return preferencesOf(db, userId);
}

/**
 * Records that `userId` is to be told about an event, once. Resolves to the
 * ledger row's id while the notification is still undelivered (new, or a
 * retry after a failed attempt), or undefined once it has been delivered.
 */
export async function claimNotification(
  db: Executor,
  entry: { userId: string; kind: string; eventKey: string },
): Promise<string | undefined> {
  await db.insert(notifications).values(entry).onConflictDoNothing();
  const [row] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.eventKey, entry.eventKey),
        eq(notifications.userId, entry.userId),
        isNull(notifications.deliveredAt),
      ),
    )
    .limit(1);
  return row?.id;
}

/** Marks a notification delivered (or given up on), so it is never sent again. */
export async function markDelivered(db: Executor, id: string, at: Date): Promise<void> {
  await db.update(notifications).set({ deliveredAt: at }).where(eq(notifications.id, id));
}

/**
 * Whether the user was sent a notification whose event key starts with
 * `prefix` after `since`, other than the one keyed `except`.
 */
export async function notifiedSince(
  db: Executor,
  userId: string,
  prefix: string,
  since: Date,
  except: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, userId),
        like(notifications.eventKey, `${prefix.replace(/[\\%_]/g, "\\$&")}%`),
        ne(notifications.eventKey, except),
        gt(notifications.createdAt, since),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** Deletes ledger rows older than `before`; resolves to how many. */
export async function pruneNotifications(db: Executor, before: Date): Promise<number> {
  const removed = await db
    .delete(notifications)
    .where(lt(notifications.createdAt, before))
    .returning({ id: notifications.id });
  return removed.length;
}

/** A booking as notifications describe it, with who is told. */
export async function notificationBooking(db: Executor, bookingId: string) {
  const [row] = await db
    .select({
      id: bookings.id,
      chargerId: bookings.chargerId,
      status: bookings.status,
      slot: bookings.slot,
      cancelledBy: bookings.cancelledBy,
      driverId: bookings.driverId,
      hostUserId: hosts.userId,
      timezone: chargers.timezone,
    })
    .from(bookings)
    .innerJoin(chargers, eq(chargers.id, bookings.chargerId))
    .innerJoin(hosts, eq(hosts.id, chargers.hostId))
    .where(eq(bookings.id, bookingId))
    .limit(1);
  return row;
}

/** A session's figures for its notifications. */
export async function notificationSession(db: Executor, sessionId: string) {
  const [row] = await db
    .select({
      id: sessions.id,
      bookingId: sessions.bookingId,
      status: sessions.status,
      kwh: sessions.kwh,
      stopReason: sessions.stopReason,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return row;
}

/**
 * What settlement captured for a booking (the amount billed to the driver)
 * and the host's share of it; undefined until the payment is captured.
 */
export async function settledAmounts(
  db: Executor,
  bookingId: string,
): Promise<{ billedCents: number; earningsCents: number; currency: string } | undefined> {
  const [row] = await db
    .select({
      capturedCents: payments.capturedCents,
      platformFeeCents: payments.platformFeeCents,
      currency: payments.currency,
    })
    .from(payments)
    .where(and(eq(payments.bookingId, bookingId), eq(payments.status, "captured")))
    .limit(1);
  if (row === undefined) return undefined;
  return {
    billedCents: row.capturedCents,
    earningsCents: row.capturedCents - row.platformFeeCents,
    currency: row.currency,
  };
}

/** A charger's state and its host's user, for charger alerts. */
export async function chargerForAlert(db: Executor, chargerId: string) {
  const [row] = await db
    .select({
      id: chargers.id,
      hostUserId: hosts.userId,
      status: chargers.status,
      lastHeartbeatAt: chargers.lastHeartbeatAt,
    })
    .from(chargers)
    .innerJoin(hosts, eq(hosts.id, chargers.hostId))
    .where(eq(chargers.id, chargerId))
    .limit(1);
  return row;
}

/** Offline chargers and when each last heartbeated, to catch up after missed events. */
export function offlineChargers(db: Executor) {
  return db
    .select({ id: chargers.id, lastHeartbeatAt: chargers.lastHeartbeatAt })
    .from(chargers)
    .where(eq(chargers.status, "offline"));
}
