import { CHARGER_EVENTS_CHANNEL, type ChargerEvent, parseChargerEvent } from "@nd/domain";
import pg from "pg";

/**
 * What a subscriber hears: an event about its charger (the gateway's
 * versioned `@nd/domain` contract), or `resync` after the connection to
 * Postgres was re-established. NOTIFY is not durable, so on `resync` a
 * subscriber must re-read the tables for anything it missed.
 */
export type ChargerSignal =
  { readonly kind: "event"; readonly event: ChargerEvent } | { readonly kind: "resync" };

export type ChargerListener = (signal: ChargerSignal) => void;

/** Subscriptions to the gateway's charger events. */
export interface ChargerEvents {
  /**
   * Starts listening for events about one charger. Resolves once events are
   * being received, so a caller can subscribe, then read the current state,
   * and never miss a change in between. Resolves to an unsubscribe function.
   */
  subscribe(chargerId: string, listener: ChargerListener): Promise<() => void>;
  /**
   * Starts listening for events about every charger, on the same connection.
   * Resolves like `subscribe` to an unsubscribe function.
   */
  subscribeAll(listener: ChargerListener): Promise<() => void>;
  close(): Promise<void>;
}

/** The part of a `pg.Client` the listener uses. */
export interface ListenClient {
  connect(): Promise<unknown>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  on(event: "notification", listener: (message: pg.Notification) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "end", listener: () => void): unknown;
}

export interface PgChargerEventsOptions {
  /** Creates a fresh client for every (re)connection. */
  readonly connect: () => ListenClient;
  /** Delay before reconnecting after the connection drops. */
  readonly reconnectDelayMs?: number;
  readonly onError?: (error: unknown) => void;
}

/**
 * Charger events from Postgres `LISTEN charger_events` on one dedicated
 * connection, shared by every subscriber. Connects on the first subscription
 * and reconnects after a drop, telling subscribers to resync.
 */
export function pgChargerEvents(options: PgChargerEventsOptions): ChargerEvents {
  const { connect, reconnectDelayMs = 1_000, onError = () => undefined } = options;
  const listeners = new Map<string, Set<ChargerListener>>();
  const everyCharger = new Set<ChargerListener>();
  let client: ListenClient | undefined;
  let connecting: Promise<void> | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let closed = false;

  const notifyAll = (signal: ChargerSignal) => {
    for (const set of listeners.values()) for (const listener of set) listener(signal);
    for (const listener of everyCharger) listener(signal);
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== undefined) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      ensureConnected().then(
        () => {
          notifyAll({ kind: "resync" });
        },
        () => undefined,
      );
    }, reconnectDelayMs);
    reconnectTimer.unref();
  };

  const dropClient = (current: ListenClient) => {
    if (client !== current) return;
    client = undefined;
    connecting = undefined;
    current.end().catch(() => undefined);
    scheduleReconnect();
  };

  function ensureConnected(): Promise<void> {
    if (closed) return Promise.reject(new Error("charger events are closed"));
    connecting ??= (async () => {
      const next = connect();
      next.on("notification", (message) => {
        if (message.channel !== CHARGER_EVENTS_CHANNEL) return;
        // Payloads that are not a valid event of this version are skipped.
        const event = parseChargerEvent(message.payload);
        if (event === undefined) return;
        for (const listener of [...(listeners.get(event.chargerId) ?? []), ...everyCharger]) {
          listener({ kind: "event", event });
        }
      });
      next.on("error", (error) => {
        onError(error);
        dropClient(next);
      });
      next.on("end", () => {
        dropClient(next);
      });
      client = next;
      try {
        await next.connect();
        await next.query(`LISTEN ${CHARGER_EVENTS_CHANNEL}`);
      } catch (error) {
        onError(error);
        dropClient(next);
        throw error;
      }
    })();
    return connecting;
  }

  return {
    async subscribe(chargerId, listener) {
      let set = listeners.get(chargerId);
      if (set === undefined) {
        set = new Set();
        listeners.set(chargerId, set);
      }
      set.add(listener);
      const unsubscribe = () => {
        set.delete(listener);
        if (set.size === 0 && listeners.get(chargerId) === set) listeners.delete(chargerId);
      };
      try {
        await ensureConnected();
      } catch (error) {
        unsubscribe();
        throw error;
      }
      return unsubscribe;
    },
    async subscribeAll(listener) {
      everyCharger.add(listener);
      const unsubscribe = () => {
        everyCharger.delete(listener);
      };
      try {
        await ensureConnected();
      } catch (error) {
        unsubscribe();
        throw error;
      }
      return unsubscribe;
    },
    async close() {
      closed = true;
      clearTimeout(reconnectTimer);
      listeners.clear();
      everyCharger.clear();
      const current = client;
      client = undefined;
      await current?.end().catch(() => undefined);
    },
  };
}

/** Charger events from the database at `databaseUrl`. */
export function createPgChargerEvents(
  databaseUrl: string,
  onError?: (error: unknown) => void,
): ChargerEvents {
  return pgChargerEvents({
    connect: () => new pg.Client({ connectionString: databaseUrl }),
    ...(onError === undefined ? {} : { onError }),
  });
}

/**
 * Re-reads state with `read` until it returns a value, waking on every signal
 * for the charger, or gives up after `timeoutMs` (or when `abort` fires) and
 * returns undefined. Subscribes before the first read, so no change is missed.
 */
export async function waitForCharger<T>(
  events: ChargerEvents,
  chargerId: string,
  read: () => Promise<T | undefined>,
  { timeoutMs, abort }: { timeoutMs: number; abort?: AbortSignal },
): Promise<T | undefined> {
  let signals = 0;
  let wake: () => void = () => undefined;
  const unsubscribe = await events.subscribe(chargerId, () => {
    signals += 1;
    wake();
  });
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const seen = signals;
      const value = await read();
      if (value !== undefined) return value;
      const remaining = deadline - Date.now();
      if (remaining <= 0 || abort?.aborted === true) return undefined;
      // A signal arrived while reading: read again rather than wait.
      if (signals !== seen) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, remaining);
        function done() {
          clearTimeout(timer);
          abort?.removeEventListener("abort", done);
          resolve();
        }
        wake = done;
        abort?.addEventListener("abort", done, { once: true });
      });
      wake = () => undefined;
    }
  } finally {
    unsubscribe();
  }
}
