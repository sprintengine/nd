import type { Executor } from "@nd/db";
import type { ChargerEvent } from "@nd/domain";

import {
  bookingAudience,
  bookingOfSession,
  chargerAudience,
  findSessionContext,
} from "../data/sessions.ts";
import type { Clock } from "../deps.ts";
import type { ChargerSignal } from "../events/charger-events.ts";
import type { RealtimeNotifier } from "../sessions/services.ts";
import { sessionState } from "../sessions/view.ts";
import type { RealtimeHub } from "./hub.ts";

// What the realtime WebSocket pushes, and to whom. Two sources feed it: the
// gateway's charger events (through the API's one LISTEN connection) and the
// API's own state changes. Each update re-reads the rows, so a message always
// carries the current state, and is sent only to the booking's driver and
// host (charger status to the host only). Nothing is read for a booking
// nobody is connected to see.

export interface RealtimeFeed extends RealtimeNotifier {
  /** Handles a signal from the charger events dispatcher. */
  handle(signal: ChargerSignal): void;
  /** Resolves when every update started so far has been sent. For tests and shutdown. */
  idle(): Promise<void>;
}

export interface RealtimeFeedOptions {
  readonly db: Executor;
  readonly clock: Clock;
  readonly hub: RealtimeHub;
  readonly log: { warn(details: object, message: string): void };
}

export function createRealtimeFeed({ db, clock, hub, log }: RealtimeFeedOptions): RealtimeFeed {
  /** The latest update queued per booking or charger; updates for one key run in order. */
  const chains = new Map<string, Promise<void>>();

  /** Runs an update in the background after the key's previous one; a failure is logged, never thrown. */
  const track = (key: string, work: () => Promise<void>, details: object) => {
    const previous = chains.get(key) ?? Promise.resolve();
    const next = previous.then(work).catch((error: unknown) => {
      log.warn({ ...details, err: error }, "realtime update failed");
    });
    chains.set(key, next);
    void next.finally(() => {
      if (chains.get(key) === next) chains.delete(key);
    });
  };

  const pushBooking = async (bookingId: string) => {
    const audience = await bookingAudience(db, bookingId);
    if (audience === undefined) return;
    const users = [audience.driverId, audience.hostUserId];
    if (!hub.anyConnected(users)) return;
    hub.send(users, {
      type: "booking:update",
      bookingId,
      status: audience.status,
      at: clock.now().toISOString(),
    });
  };

  const pushSession = async (bookingId: string) => {
    const context = await findSessionContext(db, bookingId);
    if (context === undefined) return;
    const users = [context.booking.driverId, context.hostUserId];
    if (!hub.anyConnected(users)) return;
    hub.send(users, { type: "session:update", ...sessionState(context, clock.now()) });
  };

  const pushChargerStatus = async (event: ChargerEvent) => {
    const audience = await chargerAudience(db, event.chargerId);
    if (audience === undefined || !hub.anyConnected([audience.hostUserId])) return;
    hub.send([audience.hostUserId], {
      type: "charger:status",
      chargerId: event.chargerId,
      status: audience.status,
      connectorStatus: event.type === "status" ? event.status : null,
      errorCode: event.type === "status" || event.type === "fault" ? event.errorCode : null,
      at: event.at,
    });
  };

  const onEvent = async (event: ChargerEvent) => {
    switch (event.type) {
      case "session_started":
      case "session_stopped":
        await pushBooking(event.bookingId);
        await pushSession(event.bookingId);
        return;
      case "meter": {
        const bookingId = await bookingOfSession(db, event.sessionId);
        if (bookingId !== undefined) await pushSession(bookingId);
        return;
      }
      case "status": {
        await pushChargerStatus(event);
        const bookingId =
          event.sessionId === undefined ? undefined : await bookingOfSession(db, event.sessionId);
        if (bookingId !== undefined) await pushSession(bookingId);
        return;
      }
      case "boot":
      case "fault":
      case "offline":
      case "online":
        await pushChargerStatus(event);
        return;
    }
  };

  return {
    bookingChanged(bookingId) {
      track(bookingId, () => pushBooking(bookingId), { bookingId });
    },
    sessionChanged(bookingId) {
      track(bookingId, () => pushSession(bookingId), { bookingId });
    },
    handle(signal) {
      if (signal.kind === "resync") {
        hub.broadcast({ type: "resync" });
        return;
      }
      track(signal.event.chargerId, () => onEvent(signal.event), {
        chargerId: signal.event.chargerId,
        event: signal.event.type,
      });
    },
    async idle() {
      while (chains.size > 0) await Promise.all([...chains.values()]);
    },
  };
}

/** Booking routes whose success changes a booking's status, outside session control. */
const BOOKING_ROUTES = new Set([
  "/bookings",
  "/bookings/:id/approve",
  "/bookings/:id/decline",
  "/bookings/:id/cancel",
]);

/** The booking a successful booking route changed, if it is one of {@link BOOKING_ROUTES}. */
export function changedBooking(
  route: { method: string; url: string | undefined; statusCode: number; params: unknown },
  payload: unknown,
): string | undefined {
  if (route.method !== "POST" || route.statusCode >= 300) return undefined;
  if (route.url === undefined || !BOOKING_ROUTES.has(route.url)) return undefined;
  const fromParams = (route.params as { id?: unknown } | undefined)?.id;
  if (typeof fromParams === "string") return fromParams;
  if (typeof payload !== "string") return undefined;
  try {
    const id = (JSON.parse(payload) as { id?: unknown }).id;
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}
