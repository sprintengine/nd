import { bookings, sessions } from "@nd/db";
import { CHARGER_EVENTS_CHANNEL, type ChargerEvent } from "@nd/domain";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { fakeDb, type RecordedQuery } from "../test/fake-db.ts";
import { createPgStore } from "./store.ts";

const CHARGER = { id: "8f2b8a4e-3d0c-4c4e-9d55-2f3c1b7a9e10", chargeboxId: "21234567" };
const SESSION = "0d7c6a8e-1f8b-4b8e-8a3d-6f1d2c3b4a59";
const BOOKING = "5b1e9c2d-7a4f-4e6b-9c8d-1a2b3c4d5e6f";
const at = new Date("2027-01-13T22:00:00.000Z");

type Rule = readonly [RegExp, unknown[][] | (() => never)];

/** A fake database answering the first rule whose pattern matches the SQL. */
function setup(rules: Rule[] = []) {
  const fake = fakeDb((query) => {
    for (const [pattern, rows] of rules) {
      if (pattern.test(query.text)) {
        return typeof rows === "function" ? rows() : rows;
      }
    }
    return [];
  });
  return { ...fake, store: createPgStore(fake.db) };
}

const notifications = (queries: readonly RecordedQuery[]) =>
  queries
    .filter((query) => query.text.startsWith("select pg_notify"))
    .map((query) => {
      expect(query.params[0]).toBe(CHARGER_EVENTS_CHANNEL);
      return JSON.parse(String(query.params[1])) as ChargerEvent;
    });

const texts = (queries: readonly RecordedQuery[]) => queries.map((query) => query.text);

/** A joined session+booking row as drizzle reads it from `openTransactionForCharger`. */
function openTransactionRow(status: string) {
  const session: Record<string, unknown> = {
    id: SESSION,
    bookingId: BOOKING,
    status,
    ocppTransactionId: 42,
  };
  const booking: Record<string, unknown> = { id: BOOKING, chargerId: CHARGER.id, status: "active" };
  return [
    ...Object.keys(getTableColumns(sessions)).map((key) => session[key] ?? null),
    ...Object.keys(getTableColumns(bookings)).map((key) => booking[key] ?? null),
  ];
}

describe("message log", () => {
  it("inserts messages and counts outbound calls", async () => {
    const { store, queries } = setup([[/count\(\*\)/, [[7]]]]);
    await store.recordMessage({
      chargerId: CHARGER.id,
      direction: "in",
      messageType: "call",
      messageId: "m-1",
      action: "Heartbeat",
      payload: {},
    });
    expect(queries[0]?.text).toMatch(/^insert into "ocpp_messages"/);
    await expect(store.countOutboundCalls(CHARGER.id, "ChangeConfiguration", at)).resolves.toBe(7);
    expect(queries[1]?.params).toEqual([
      CHARGER.id,
      "out",
      "call",
      "ChangeConfiguration",
      at.toISOString(),
    ]);
  });

  it("counts zero when there is no row", async () => {
    const { store } = setup();
    await expect(store.countOutboundCalls(CHARGER.id, "ChangeConfiguration", at)).resolves.toBe(0);
  });

  it("reads credentials with the one helper that returns the hash", async () => {
    const { store, queries } = setup();
    await expect(store.findCredentials("21234567")).resolves.toBeUndefined();
    expect(queries[0]?.text).toContain('"ocpp_auth_hash"');
  });
});

describe("charger state", () => {
  it("records a boot and publishes it", async () => {
    const { store, queries } = setup();
    await store.recordBoot(CHARGER, "5.794", at);
    expect(texts(queries)).toEqual([
      "begin",
      expect.stringMatching(
        /^update "chargers" set "firmware" = \$1, "status" = \$2, "last_heartbeat_at"/,
      ),
      "select pg_notify($1, $2)",
      "commit",
    ]);
    expect(notifications(queries)).toEqual([
      {
        v: 1,
        at: at.toISOString(),
        chargerId: CHARGER.id,
        chargeboxId: "21234567",
        type: "boot",
        firmware: "5.794",
      },
    ]);
    const other = setup();
    await other.store.recordBoot(CHARGER, null, at);
    expect(other.queries[1]?.text).not.toContain('"firmware"');
  });

  it("records a heartbeat, bringing an offline charger back online", async () => {
    const online = setup([[/^select "status" from "chargers"/, [["online"]]]]);
    await online.store.recordHeartbeat(CHARGER, at);
    expect(notifications(online.queries)).toEqual([]);
    expect(online.queries[2]?.text).not.toMatch(/"status"/);

    const offline = setup([[/^select "status" from "chargers"/, [["offline"]]]]);
    await offline.store.recordHeartbeat(CHARGER, at);
    expect(offline.queries[2]?.text).toMatch(/"status" = \$1/);
    expect(notifications(offline.queries).map((event) => event.type)).toEqual(["online"]);
  });

  it("saves the OCPP configuration", async () => {
    const { store, queries } = setup();
    await store.saveOcppConfig(CHARGER.id, { FreeCharging: "false" });
    expect(queries[0]?.params[0]).toBe('{"FreeCharging":"false"}');
  });

  it("marks silent chargers offline and publishes each", async () => {
    const { store, queries } = setup([
      [
        /^update "chargers" set "status"/,
        [
          [CHARGER.id, "21234567", at],
          [SESSION, "29999999", null],
        ],
      ],
    ]);
    await expect(
      store.markStaleChargersOffline(new Date(at.getTime() - 900_000), at),
    ).resolves.toBe(2);
    expect(notifications(queries)).toEqual([
      expect.objectContaining({
        type: "offline",
        chargerId: CHARGER.id,
        lastHeartbeatAt: at.toISOString(),
      }),
      expect.objectContaining({ type: "offline", chargerId: SESSION, lastHeartbeatAt: null }),
    ]);
  });
});

describe("status notifications", () => {
  it("faults the charger and publishes status and fault", async () => {
    const { store, queries } = setup([[/^select "status" from "chargers"/, [["online"]]]]);
    await expect(
      store.recordStatus(
        CHARGER,
        {
          connectorId: 1,
          status: "Faulted",
          errorCode: "GroundFailure",
          info: "RCD",
          vendorErrorCode: "E1",
        },
        at,
      ),
    ).resolves.toEqual({ chargerStatus: "faulted", session: undefined });
    expect(texts(queries)).toContainEqual(expect.stringMatching(/^update "chargers" set "status"/));
    expect(notifications(queries)).toEqual([
      expect.objectContaining({ type: "status", status: "Faulted", errorCode: "GroundFailure" }),
      expect.objectContaining({
        type: "fault",
        errorCode: "GroundFailure",
        info: "RCD",
        vendorErrorCode: "E1",
      }),
    ]);
  });

  it("maps a connector status onto the open session", async () => {
    const { store, queries } = setup([
      [/^select "status" from "chargers"/, [["offline"]]],
      [/^select "sessions"\."id"/, [openTransactionRow("charging")]],
    ]);
    await expect(
      store.recordStatus(
        CHARGER,
        { connectorId: 1, status: "SuspendedEV", errorCode: "NoError" },
        at,
      ),
    ).resolves.toEqual({
      chargerStatus: "online",
      session: { id: SESSION, status: "suspended_ev" },
    });
    expect(texts(queries)).toContainEqual(expect.stringMatching(/^update "sessions" set "status"/));
    expect(notifications(queries)).toEqual([
      expect.objectContaining({ type: "online" }),
      expect.objectContaining({
        type: "status",
        sessionId: SESSION,
        sessionStatus: "suspended_ev",
      }),
    ]);
  });

  it("leaves a starting session and an unknown charger alone", async () => {
    const { store, queries } = setup([
      [/^select "sessions"\."id"/, [openTransactionRow("starting")]],
    ]);
    await expect(
      store.recordStatus(CHARGER, { connectorId: 1, status: "Charging", errorCode: "NoError" }, at),
    ).resolves.toEqual({ chargerStatus: "onboarding", session: undefined });
    expect(texts(queries).some((text) => text.startsWith("update"))).toBe(false);
  });
});

describe("idTag facts", () => {
  it("reads the booking, the host tag and whether a paid booking holds the slot", async () => {
    const { store, queries } = setup([
      [/from "bookings" where \("bookings"\."charger_id" = \$2/, [[BOOKING, "arrived", true]]],
      [/^select "host_id_tag"/, [["HOST1"]]],
      [/&&/, [Array.from({ length: Object.keys(getTableColumns(bookings)).length }, () => null)]],
    ]);
    await expect(store.tagFacts(CHARGER.id, "TAG", at)).resolves.toEqual({
      booking: { id: BOOKING, status: "arrived", slotOpen: true },
      hostIdTag: "HOST1",
      paidWindow: true,
    });
    expect(queries[0]?.params).toEqual([at.toISOString(), CHARGER.id, "TAG", 1]);
  });

  it("knows nothing about an unknown tag on an unknown charger", async () => {
    const { store } = setup();
    await expect(store.tagFacts(CHARGER.id, "TAG", at)).resolves.toEqual({
      booking: undefined,
      hostIdTag: null,
      paidWindow: false,
    });
  });
});

describe("booking sessions", () => {
  const input = { bookingId: BOOKING, meterStartWh: 1000, startedAt: at };

  it("creates a charging session, activates the booking and publishes", async () => {
    const { store, queries } = setup([[/^insert into "sessions"/, [[SESSION]]]]);
    const started = await store.startBookingSession(CHARGER, input);
    expect(started).toMatchObject({ sessionId: SESSION, created: true });
    expect(texts(queries)).toEqual([
      "begin",
      expect.stringMatching(/^select "id", "status", "ocpp_transaction_id"/),
      expect.stringMatching(/^insert into "sessions"/),
      expect.stringMatching(/^update "bookings" set "status" = \$1/),
      "select pg_notify($1, $2)",
      "commit",
    ]);
    expect(notifications(queries)).toEqual([
      expect.objectContaining({
        type: "session_started",
        sessionId: SESSION,
        bookingId: BOOKING,
        transactionId: started.transactionId,
        meterStartWh: 1000,
      }),
    ]);
  });

  it("takes over the session the API created on RemoteStart", async () => {
    const { store, queries } = setup([
      [/^select "id", "status"/, [[SESSION, "starting", null, null, null]]],
    ]);
    await expect(store.startBookingSession(CHARGER, input)).resolves.toMatchObject({
      sessionId: SESSION,
      created: true,
    });
    expect(texts(queries)[2]).toMatch(/^update "sessions" set "ocpp_transaction_id"/);
  });

  it("answers a repeated StartTransaction with the same transaction", async () => {
    const { store, queries } = setup([
      [/^select "id", "status"/, [[SESSION, "charging", 77, 1000, at]]],
    ]);
    await expect(store.startBookingSession(CHARGER, input)).resolves.toEqual({
      sessionId: SESSION,
      transactionId: 77,
      created: false,
    });
    expect(notifications(queries)).toEqual([]);
  });

  it("retries on a transaction id collision, and gives up after three", async () => {
    let attempts = 0;
    const collide = () => {
      attempts += 1;
      throw Object.assign(new Error("duplicate key"), { code: "23505" });
    };
    const { store } = setup([[/^insert into "sessions"/, collide]]);
    await expect(store.startBookingSession(CHARGER, input)).rejects.toThrow();
    expect(attempts).toBe(3);

    const other = setup([
      [
        /^insert into "sessions"/,
        () => {
          throw new Error("boom");
        },
      ],
    ]);
    await expect(other.store.startBookingSession(CHARGER, input)).rejects.toThrow(/Failed query/);
  });
});

describe("meter values", () => {
  const samples = [
    { ts: at, energyWh: 1500, powerW: 7200, currentA: 31.3 },
    { ts: new Date(at.getTime() + 60_000), energyWh: 1620, powerW: 7150, currentA: null },
  ];

  it("stores samples for a transaction and publishes the latest", async () => {
    const { store, queries } = setup([
      [/inner join "bookings"/, [[SESSION, BOOKING, "charging", 1000, null]]],
    ]);
    await expect(store.recordMeterValues(CHARGER, 42, samples)).resolves.toBe(SESSION);
    expect(texts(queries)).toContainEqual(expect.stringMatching(/^insert into "meter_values"/));
    expect(notifications(queries)).toEqual([
      expect.objectContaining({
        type: "meter",
        sessionId: SESSION,
        transactionId: 42,
        energyWh: 1620,
        powerW: 7150,
      }),
    ]);
  });

  it("falls back to the open session without a transaction id", async () => {
    const { store } = setup([[/^select "sessions"\."id"/, [openTransactionRow("charging")]]]);
    await expect(store.recordMeterValues(CHARGER, undefined, samples)).resolves.toBe(SESSION);
    const none = setup();
    await expect(
      none.store.recordMeterValues(CHARGER, undefined, samples),
    ).resolves.toBeUndefined();
  });

  it("stores nothing without a session or without samples", async () => {
    const { store, queries } = setup();
    await expect(store.recordMeterValues(CHARGER, 42, samples)).resolves.toBeUndefined();
    const empty = setup([[/inner join "bookings"/, [[SESSION, BOOKING, "charging", 1000, null]]]]);
    await expect(empty.store.recordMeterValues(CHARGER, 42, [])).resolves.toBeUndefined();
    expect(
      [...texts(queries), ...texts(empty.queries)].some((text) => text.startsWith("insert")),
    ).toBe(false);
  });
});

describe("stopping sessions", () => {
  const input = {
    transactionId: 42,
    meterStopWh: 8250,
    stoppedAt: at,
    reason: "Remote",
    samples: [],
  };

  it("closes the session with kWh, completes the booking and publishes", async () => {
    const { store, queries } = setup([
      [/inner join "bookings"/, [[SESSION, BOOKING, "charging", 1000, null]]],
    ]);
    await expect(
      store.stopSession(CHARGER, {
        ...input,
        samples: [{ ts: at, energyWh: 8250, powerW: 0, currentA: 0 }],
      }),
    ).resolves.toEqual({
      sessionId: SESSION,
      bookingId: BOOKING,
      status: "stopped",
      kwh: 7.25,
      changed: true,
    });
    expect(texts(queries)).toEqual([
      "begin",
      expect.stringMatching(/for update of "sessions"$/),
      expect.stringMatching(/^insert into "meter_values"/),
      expect.stringMatching(/^update "sessions" set "meter_stop_wh"/),
      expect.stringMatching(/^update "bookings" set "status"/),
      "select pg_notify($1, $2)",
      "commit",
    ]);
    expect(notifications(queries)).toEqual([
      expect.objectContaining({
        type: "session_stopped",
        sessionStatus: "stopped",
        kwh: 7.25,
        meterStopWh: 8250,
        reason: "Remote",
      }),
    ]);
  });

  it("sends a session whose meter went backwards to review", async () => {
    const { store } = setup([
      [/inner join "bookings"/, [[SESSION, BOOKING, "suspended_ev", 9000, null]]],
    ]);
    await expect(store.stopSession(CHARGER, input)).resolves.toMatchObject({
      status: "needs_review",
      kwh: null,
    });
  });

  it("uses the stop reading when the start is unknown", async () => {
    const { store } = setup([
      [/inner join "bookings"/, [[SESSION, BOOKING, "charging", null, null]]],
    ]);
    await expect(store.stopSession(CHARGER, input)).resolves.toMatchObject({
      status: "stopped",
      kwh: 0,
    });
  });

  it("ignores a repeated stop and an unknown transaction", async () => {
    const repeat = setup([
      [/inner join "bookings"/, [[SESSION, BOOKING, "stopped", 1000, "7.250"]]],
    ]);
    await expect(repeat.store.stopSession(CHARGER, input)).resolves.toEqual({
      sessionId: SESSION,
      bookingId: BOOKING,
      status: "stopped",
      kwh: 7.25,
      changed: false,
    });
    expect(notifications(repeat.queries)).toEqual([]);
    const unknown = setup();
    await expect(unknown.store.stopSession(CHARGER, input)).resolves.toBeUndefined();
  });
});

describe("kWh cap", () => {
  it("reports a session that has delivered its cap, from the highest reading", async () => {
    const fake = fakeDb((query) =>
      query.text.includes("having max(mv.energy_wh)")
        ? [{ transaction_id: 42, delivered_wh: "10250", kwh_cap: "10.00" }]
        : [],
    );
    await expect(createPgStore(fake.db).kwhCapReached(SESSION)).resolves.toEqual({
      transactionId: 42,
      deliveredKwh: 10.25,
      kwhCap: 10,
    });
    expect(fake.queries[0]?.params).toContain(SESSION);
  });

  it("reports nothing below the cap or without one", async () => {
    const { store } = setup();
    await expect(store.kwhCapReached(SESSION)).resolves.toBeUndefined();
  });
});
