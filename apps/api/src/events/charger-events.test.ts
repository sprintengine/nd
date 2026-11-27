import { EventEmitter } from "node:events";

import { CHARGER_EVENTS_CHANNEL } from "@nd/domain";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  type ChargerEvents,
  type ChargerSignal,
  createPgChargerEvents,
  type ListenClient,
  pgChargerEvents,
  waitForCharger,
} from "./charger-events.ts";

class FakeClient extends EventEmitter implements ListenClient {
  queries: string[] = [];
  ended = false;
  private readonly failConnect: boolean;
  constructor(failConnect = false) {
    super();
    this.failConnect = failConnect;
  }
  connect() {
    return this.failConnect ? Promise.reject(new Error("refused")) : Promise.resolve();
  }
  query(sql: string) {
    this.queries.push(sql);
    return Promise.resolve();
  }
  end() {
    this.ended = true;
    return Promise.resolve();
  }
  notify(payload: string, channel = CHARGER_EVENTS_CHANNEL) {
    this.emit("notification", { channel, payload, processId: 1 } satisfies pg.Notification);
  }
}

const C1 = "11111111-1111-4111-8111-111111111111";
const C2 = "22222222-2222-4222-8222-222222222222";

/** A boot event as the gateway publishes it. */
const boot = (chargerId: string) => ({
  v: 1,
  type: "boot",
  at: "2027-01-11T12:00:00.000Z",
  chargerId,
  chargeboxId: "NDTEST000001",
  firmware: "5.794",
});

describe("pgChargerEvents", () => {
  it("listens once and delivers each event to the charger's subscribers only", async () => {
    const clients: FakeClient[] = [];
    const events = pgChargerEvents({
      connect: () => {
        const client = new FakeClient();
        clients.push(client);
        return client;
      },
    });
    const heard: ChargerSignal[] = [];
    const other: ChargerSignal[] = [];
    const stop = await events.subscribe(C1, (signal) => heard.push(signal));
    await events.subscribe(C2, (signal) => other.push(signal));
    expect(clients).toHaveLength(1);
    expect(clients[0]?.queries).toEqual(["LISTEN charger_events"]);

    clients[0]?.notify(JSON.stringify(boot(C1)));
    clients[0]?.notify(JSON.stringify(boot(C1)), "something_else");
    clients[0]?.notify(JSON.stringify({ ...boot(C1), v: 2 }));
    clients[0]?.notify("garbage");
    expect(heard).toEqual([{ kind: "event", event: boot(C1) }]);
    expect(other).toEqual([]);

    stop();
    clients[0]?.notify(JSON.stringify(boot(C1)));
    expect(heard).toHaveLength(1);
    await events.close();
    expect(clients[0]?.ended).toBe(true);
    await expect(events.subscribe(C1, () => undefined)).rejects.toThrow(/closed/);
  });

  it("reconnects after the connection drops and tells subscribers to resync", async () => {
    vi.useFakeTimers();
    try {
      const clients: FakeClient[] = [];
      const errors: unknown[] = [];
      const events = pgChargerEvents({
        connect: () => {
          const client = new FakeClient();
          clients.push(client);
          return client;
        },
        reconnectDelayMs: 10,
        onError: (error) => errors.push(error),
      });
      const heard: ChargerSignal[] = [];
      await events.subscribe(C1, (signal) => heard.push(signal));
      clients[0]?.emit("error", new Error("connection reset"));
      clients[0]?.emit("end");
      expect(errors).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(20);
      expect(clients).toHaveLength(2);
      expect(heard).toEqual([{ kind: "resync" }]);
      clients[1]?.notify(JSON.stringify(boot(C1)));
      expect(heard).toHaveLength(2);
      await events.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a subscription when Postgres cannot be reached, and retries later", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const events = pgChargerEvents({
        connect: () => new FakeClient(++attempts === 1),
        reconnectDelayMs: 10,
      });
      await expect(events.subscribe("c1", () => undefined)).rejects.toThrow("refused");
      await vi.advanceTimersByTimeAsync(20);
      expect(attempts).toBe(2);
      await expect(events.subscribe("c1", () => undefined)).resolves.toBeTypeOf("function");
      await events.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("delivers every charger's events and resyncs to subscribers of all chargers", async () => {
    vi.useFakeTimers();
    try {
      const clients: FakeClient[] = [];
      const events = pgChargerEvents({
        connect: () => {
          const client = new FakeClient();
          clients.push(client);
          return client;
        },
        reconnectDelayMs: 10,
      });
      const all: ChargerSignal[] = [];
      const one: ChargerSignal[] = [];
      const stop = await events.subscribeAll((signal) => all.push(signal));
      await events.subscribe(C1, (signal) => one.push(signal));
      expect(clients).toHaveLength(1);
      clients[0]?.notify(JSON.stringify(boot(C1)));
      clients[0]?.notify(JSON.stringify(boot(C2)));
      expect(all.map((signal) => signal.kind === "event" && signal.event.chargerId)).toEqual([
        C1,
        C2,
      ]);
      expect(one).toHaveLength(1);
      clients[0]?.emit("end");
      await vi.advanceTimersByTimeAsync(20);
      expect(all.at(-1)).toEqual({ kind: "resync" });
      stop();
      clients[1]?.notify(JSON.stringify(boot(C2)));
      expect(all).toHaveLength(3);
      await events.close();
      await expect(events.subscribeAll(() => undefined)).rejects.toThrow(/closed/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates real clients lazily", async () => {
    const events = createPgChargerEvents("postgres://nobody@127.0.0.1:1/none", () => undefined);
    await events.close();
  });
});

function manualEvents() {
  const listeners = new Set<(signal: ChargerSignal) => void>();
  const events: ChargerEvents = {
    subscribe: (_chargerId, listener) => {
      listeners.add(listener);
      return Promise.resolve(() => listeners.delete(listener));
    },
    subscribeAll: () => Promise.reject(new Error("not used")),
    close: () => Promise.resolve(),
  };
  return {
    events,
    fire: () => {
      for (const listener of listeners) listener({ kind: "resync" });
    },
    count: () => listeners.size,
  };
}

describe("waitForCharger", () => {
  it("returns at once when the state is already there", async () => {
    const { events, count } = manualEvents();
    await expect(
      waitForCharger(events, "c1", () => Promise.resolve("online"), { timeoutMs: 1000 }),
    ).resolves.toBe("online");
    expect(count()).toBe(0);
  });

  it("re-reads on every signal until the state changes", async () => {
    const { events, fire, count } = manualEvents();
    let reads = 0;
    const waiting = waitForCharger(
      events,
      "c1",
      () => Promise.resolve(++reads >= 3 ? "online" : undefined),
      { timeoutMs: 5_000 },
    );
    await vi.waitFor(() => {
      expect(reads).toBe(1);
    });
    fire();
    await vi.waitFor(() => {
      expect(reads).toBe(2);
    });
    fire();
    await expect(waiting).resolves.toBe("online");
    expect(count()).toBe(0);
  });

  it("re-reads straight away when a signal arrives during a read", async () => {
    const { events, fire } = manualEvents();
    let reads = 0;
    const result = await waitForCharger(
      events,
      "c1",
      () => {
        reads += 1;
        if (reads === 1) fire();
        return Promise.resolve(reads === 2 ? "online" : undefined);
      },
      { timeoutMs: 5_000 },
    );
    expect(result).toBe("online");
  });

  it("gives up after the timeout", async () => {
    const { events } = manualEvents();
    await expect(
      waitForCharger(events, "c1", () => Promise.resolve(undefined), { timeoutMs: 20 }),
    ).resolves.toBeUndefined();
  });

  it("gives up when aborted", async () => {
    const { events } = manualEvents();
    const abort = new AbortController();
    const waiting = waitForCharger(events, "c1", () => Promise.resolve(undefined), {
      timeoutMs: 60_000,
      abort: abort.signal,
    });
    setTimeout(() => {
      abort.abort();
    }, 10);
    await expect(waiting).resolves.toBeUndefined();
  });
});
