import { type Mock, vi } from "vitest";

import type { TagFacts } from "../src/rules.ts";
import type { GatewayStore, OcppMessageRecord } from "../src/store.ts";

/** GatewayStore with every method a spy (declared as properties, so they can be passed around). */
type SpyStore = { -readonly [K in keyof GatewayStore]: Mock<GatewayStore[K]> };

export interface FakeStore extends SpyStore {
  readonly messages: OcppMessageRecord[];
  readonly configs: Map<string, Record<string, string>>;
  credentials: Map<string, { id: string; chargeboxId: string; ocppAuthHash: string | null }>;
  facts: TagFacts;
  /** When set, recordMessage rejects for inbound CALLs. */
  failInboundCalls: boolean;
  outboundCallCount: number;
}

/** An in-memory GatewayStore whose methods are spies, for unit tests. */
export function fakeStore(): FakeStore {
  const store: FakeStore = {
    messages: [],
    configs: new Map(),
    credentials: new Map(),
    facts: { booking: undefined, hostIdTag: null, paidWindow: false },
    failInboundCalls: false,
    outboundCallCount: 0,
    findCredentials: vi.fn((chargeboxId: string) =>
      Promise.resolve(store.credentials.get(chargeboxId)),
    ),
    recordMessage: vi.fn((message: OcppMessageRecord) => {
      if (store.failInboundCalls && message.direction === "in" && message.messageType === "call") {
        return Promise.reject(new Error("database down"));
      }
      store.messages.push(message);
      return Promise.resolve();
    }),
    countOutboundCalls: vi.fn(() => Promise.resolve(store.outboundCallCount)),
    recordBoot: vi.fn(() => Promise.resolve()),
    recordHeartbeat: vi.fn(() => Promise.resolve()),
    saveOcppConfig: vi.fn((chargerId: string, config: Record<string, string>) => {
      store.configs.set(chargerId, config);
      return Promise.resolve();
    }),
    recordStatus: vi.fn(() => Promise.resolve({ chargerStatus: "online" as const })),
    tagFacts: vi.fn(() => Promise.resolve(store.facts)),
    startBookingSession: vi.fn(() =>
      Promise.resolve({ sessionId: "session-1", transactionId: 42, created: true }),
    ),
    recordMeterValues: vi.fn(() => Promise.resolve<string | undefined>("session-1")),
    stopSession: vi.fn(() =>
      Promise.resolve({
        sessionId: "session-1",
        bookingId: "booking-1",
        status: "stopped" as const,
        kwh: 1.5,
        changed: true,
      }),
    ),
    markStaleChargersOffline: vi.fn(() => Promise.resolve(0)),
  };
  return store;
}
