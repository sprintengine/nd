import {
  bookings,
  bookingsInWindow,
  type ChargerCredentials,
  chargers,
  type Db,
  type Executor,
  findChargerCredentials,
  meterValues,
  ocppMessages,
  openTransactionForCharger,
  payments,
  sessions,
} from "@nd/db";
import {
  CHARGER_EVENT_VERSION,
  CHARGER_EVENTS_CHANNEL,
  type ChargerEvent,
  chargerEventSchema,
  type ChargerStatus,
  isOpenSession,
  type OcppMessageDirection,
  type OcppMessageType,
  OPEN_SESSION_STATUSES,
  type SessionStatus,
  SLOT_HOLDING_BOOKING_STATUSES,
} from "@nd/domain";
import type { ChargePointErrorCode, ChargePointStatus } from "@nd/ocpp-core";
import { and, count, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";

import type { MeterSample } from "./meter.ts";
import {
  chargerStatusAfterNotification,
  deliveredKwh,
  isFault,
  randomTransactionId,
  sessionStatusAfterNotification,
  type TagFacts,
} from "./rules.ts";

/** A connected charger, as the gateway refers to it. */
export interface ChargerRef {
  readonly id: string;
  readonly chargeboxId: string;
}

/** One OCPP frame for the append-only `ocpp_messages` log. */
export interface OcppMessageRecord {
  readonly chargerId: string;
  readonly direction: OcppMessageDirection;
  readonly messageType: OcppMessageType;
  readonly messageId: string;
  readonly action: string | null;
  readonly payload: unknown;
}

export interface StatusReport {
  readonly connectorId: number;
  readonly status: ChargePointStatus;
  readonly errorCode: ChargePointErrorCode;
  readonly info?: string | undefined;
  readonly vendorErrorCode?: string | undefined;
}

export interface StatusOutcome {
  readonly chargerStatus: ChargerStatus;
  /** Set when the report moved the open session to a new status. */
  readonly session?: { readonly id: string; readonly status: SessionStatus } | undefined;
}

export interface StartSessionInput {
  readonly bookingId: string;
  readonly meterStartWh: number;
  readonly startedAt: Date;
}

export interface StartedSession {
  readonly sessionId: string;
  readonly transactionId: number;
  /** False when this repeated a StartTransaction already stored. */
  readonly created: boolean;
}

export interface StopSessionInput {
  readonly transactionId: number;
  readonly meterStopWh: number;
  readonly stoppedAt: Date;
  readonly reason: string | null;
  readonly samples: readonly MeterSample[];
}

export interface StoppedSession {
  readonly sessionId: string;
  readonly bookingId: string;
  readonly status: SessionStatus;
  readonly kwh: number | null;
  /** False when the session had already stopped (a repeated StopTransaction). */
  readonly changed: boolean;
}

/** An open booking session whose delivered energy has reached the booking's kWh cap. */
export interface KwhCapReached {
  readonly transactionId: number;
  readonly deliveredKwh: number;
  readonly kwhCap: number;
}

/**
 * Everything the gateway reads and writes. Each write that other services
 * care about publishes its charger event in the same transaction.
 */
export interface GatewayStore {
  findCredentials(chargeboxId: string): Promise<ChargerCredentials | undefined>;
  recordMessage(message: OcppMessageRecord): Promise<void>;
  /** Outbound CALLs of `action` to a charger since `since` (for the config write budget). */
  countOutboundCalls(chargerId: string, action: string, since: Date): Promise<number>;
  recordBoot(charger: ChargerRef, firmware: string | null, at: Date): Promise<void>;
  recordHeartbeat(charger: ChargerRef, at: Date): Promise<void>;
  saveOcppConfig(chargerId: string, config: Record<string, string>): Promise<void>;
  recordStatus(charger: ChargerRef, report: StatusReport, at: Date): Promise<StatusOutcome>;
  tagFacts(chargerId: string, idTag: string, at: Date): Promise<TagFacts>;
  startBookingSession(charger: ChargerRef, input: StartSessionInput): Promise<StartedSession>;
  /** Stores samples for a session; returns its id, or undefined when no session matches. */
  recordMeterValues(
    charger: ChargerRef,
    transactionId: number | undefined,
    samples: readonly MeterSample[],
  ): Promise<string | undefined>;
  /** Closes the session of a transaction; undefined when it is not a booking session. */
  stopSession(charger: ChargerRef, input: StopSessionInput): Promise<StoppedSession | undefined>;
  /** Marks chargers whose last heartbeat is before `cutoff` offline; returns how many. */
  markStaleChargersOffline(cutoff: Date, at: Date): Promise<number>;
  /** Set when the open session has delivered its booking's kWh cap or more. */
  kwhCapReached(sessionId: string): Promise<KwhCapReached | undefined>;
}

type EventFields = ChargerEvent extends infer E
  ? E extends ChargerEvent
    ? Omit<E, "v" | "at" | "chargerId" | "chargeboxId">
    : never
  : never;

function chargerEvent(charger: ChargerRef, at: Date, fields: EventFields): ChargerEvent {
  return {
    v: CHARGER_EVENT_VERSION,
    at: at.toISOString(),
    chargerId: charger.id,
    chargeboxId: charger.chargeboxId,
    ...fields,
  };
}

/** Publishes an event; delivered to listeners when the surrounding transaction commits. */
async function notify(executor: Executor, event: ChargerEvent): Promise<void> {
  const payload = JSON.stringify(chargerEventSchema.parse(event));
  await executor.execute(sql`select pg_notify(${CHARGER_EVENTS_CHANNEL}, ${payload})`);
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if ("code" in current && current.code === "23505") {
      return true;
    }
    current = current.cause;
  }
  return false;
}

const TRANSACTION_ID_ATTEMPTS = 3;

async function insertSamples(
  executor: Executor,
  sessionId: string,
  samples: readonly MeterSample[],
): Promise<void> {
  if (samples.length > 0) {
    await executor.insert(meterValues).values(samples.map((sample) => ({ sessionId, ...sample })));
  }
}

/** The booking session of an OCPP transaction on a charger, locked for update. */
async function sessionForTransaction(executor: Executor, chargerId: string, transactionId: number) {
  const [row] = await executor
    .select({
      id: sessions.id,
      bookingId: sessions.bookingId,
      status: sessions.status,
      meterStartWh: sessions.meterStartWh,
      kwh: sessions.kwh,
    })
    .from(sessions)
    .innerJoin(bookings, eq(sessions.bookingId, bookings.id))
    .where(and(eq(sessions.ocppTransactionId, transactionId), eq(bookings.chargerId, chargerId)))
    .limit(1)
    .for("update", { of: sessions });
  return row;
}

/**
 * The session's transaction and energy delivered so far (the highest meter
 * reading less the start), when it is still open and its booking's kWh cap
 * is reached. Undefined without a cap, a transaction or a reading.
 */
async function kwhCapReached(db: Executor, sessionId: string): Promise<KwhCapReached | undefined> {
  const result = await db.execute<{
    transaction_id: number;
    delivered_wh: number | string;
    kwh_cap: number | string;
  }>(sql`
    select s.ocpp_transaction_id as transaction_id,
      max(mv.energy_wh) - s.meter_start_wh as delivered_wh,
      b.kwh_cap
    from ${sessions} s
    join ${bookings} b on b.id = s.booking_id
    join ${meterValues} mv on mv.session_id = s.id and mv.energy_wh is not null
    where s.id = ${sessionId}
      and s.status in (${sql.join(
        OPEN_SESSION_STATUSES.map((status) => sql`${status}::session_status`),
        sql`, `,
      )})
      and s.ocpp_transaction_id is not null
      and s.meter_start_wh is not null
      and b.kwh_cap is not null
    group by s.id, b.id
    having max(mv.energy_wh) - s.meter_start_wh >= b.kwh_cap * 1000
  `);
  const [row] = result.rows;
  if (row === undefined) return undefined;
  return {
    transactionId: row.transaction_id,
    deliveredKwh: Number(row.delivered_wh) / 1000,
    kwhCap: Number(row.kwh_cap),
  };
}

/** The gateway's store on Postgres. */
export function createPgStore(db: Db): GatewayStore {
  return {
    findCredentials: (chargeboxId) => findChargerCredentials(db, chargeboxId),

    async recordMessage(message) {
      await db.insert(ocppMessages).values(message);
    },

    async countOutboundCalls(chargerId, action, since) {
      const [row] = await db
        .select({ n: count() })
        .from(ocppMessages)
        .where(
          and(
            eq(ocppMessages.chargerId, chargerId),
            eq(ocppMessages.direction, "out"),
            eq(ocppMessages.messageType, "call"),
            eq(ocppMessages.action, action),
            gte(ocppMessages.ts, since),
          ),
        );
      return row?.n ?? 0;
    },

    recordBoot: (charger, firmware, at) =>
      db.transaction(async (tx) => {
        await tx
          .update(chargers)
          .set({
            status: "online",
            lastHeartbeatAt: at,
            ...(firmware === null ? {} : { firmware }),
          })
          .where(eq(chargers.id, charger.id));
        await notify(tx, chargerEvent(charger, at, { type: "boot", firmware }));
      }),

    recordHeartbeat: (charger, at) =>
      db.transaction(async (tx) => {
        const [row] = await tx
          .select({ status: chargers.status })
          .from(chargers)
          .where(eq(chargers.id, charger.id))
          .for("update");
        const back = row?.status === "offline";
        await tx
          .update(chargers)
          .set({ lastHeartbeatAt: at, ...(back ? { status: "online" as const } : {}) })
          .where(eq(chargers.id, charger.id));
        if (back) {
          await notify(tx, chargerEvent(charger, at, { type: "online" }));
        }
      }),

    async saveOcppConfig(chargerId, config) {
      await db.update(chargers).set({ ocppConfig: config }).where(eq(chargers.id, chargerId));
    },

    recordStatus: (charger, report, at) =>
      db.transaction(async (tx) => {
        const [row] = await tx
          .select({ status: chargers.status })
          .from(chargers)
          .where(eq(chargers.id, charger.id))
          .for("update");
        const current = row?.status ?? "onboarding";
        const chargerStatus = chargerStatusAfterNotification(
          current,
          report.errorCode,
          report.status,
        );
        if (chargerStatus !== current) {
          await tx
            .update(chargers)
            .set({ status: chargerStatus })
            .where(eq(chargers.id, charger.id));
          if (current === "offline") {
            await notify(tx, chargerEvent(charger, at, { type: "online" }));
          }
        }
        let session: StatusOutcome["session"];
        const open = await openTransactionForCharger(tx, charger.id);
        const next =
          open === undefined
            ? undefined
            : sessionStatusAfterNotification(open.session.status, report.status);
        if (open !== undefined && next !== undefined) {
          await tx.update(sessions).set({ status: next }).where(eq(sessions.id, open.session.id));
          session = { id: open.session.id, status: next };
        }
        await notify(
          tx,
          chargerEvent(charger, at, {
            type: "status",
            connectorId: report.connectorId,
            status: report.status,
            errorCode: report.errorCode,
            ...(session === undefined
              ? {}
              : { sessionId: session.id, sessionStatus: session.status }),
          }),
        );
        if (isFault(report.errorCode, report.status)) {
          await notify(
            tx,
            chargerEvent(charger, at, {
              type: "fault",
              connectorId: report.connectorId,
              errorCode: report.errorCode,
              ...(report.info === undefined ? {} : { info: report.info }),
              ...(report.vendorErrorCode === undefined
                ? {}
                : { vendorErrorCode: report.vendorErrorCode }),
            }),
          );
        }
        return { chargerStatus, session };
      }),

    async tagFacts(chargerId, idTag, at) {
      const atIso = at.toISOString();
      const [booking] = await db
        .select({
          id: bookings.id,
          status: bookings.status,
          slotOpen: sql<boolean>`${bookings.slot} @> ${atIso}::timestamptz`,
        })
        .from(bookings)
        // Only a paid booking's tag unlocks the charger: until its payment has
        // gone through, the tag reads as unknown.
        .innerJoin(payments, and(eq(payments.bookingId, bookings.id), eq(payments.status, "paid")))
        .where(and(eq(bookings.chargerId, chargerId), eq(bookings.idTag, idTag)))
        .limit(1);
      const [charger] = await db
        .select({ hostIdTag: chargers.hostIdTag })
        .from(chargers)
        .where(eq(chargers.id, chargerId))
        .limit(1);
      const holding = await bookingsInWindow(db, {
        chargerId,
        window: { start: at, end: new Date(at.getTime() + 1) },
        statuses: SLOT_HOLDING_BOOKING_STATUSES,
      });
      return {
        booking,
        hostIdTag: charger?.hostIdTag ?? null,
        paidWindow: holding.length > 0,
      };
    },

    async startBookingSession(charger, input) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await db.transaction(async (tx) => {
            const open = await tx
              .select({
                id: sessions.id,
                status: sessions.status,
                transactionId: sessions.ocppTransactionId,
                meterStartWh: sessions.meterStartWh,
                startedAt: sessions.startedAt,
              })
              .from(sessions)
              .where(
                and(
                  eq(sessions.bookingId, input.bookingId),
                  inArray(sessions.status, OPEN_SESSION_STATUSES),
                ),
              )
              .for("update");
            const repeat = open.find(
              (row) =>
                row.transactionId !== null &&
                row.meterStartWh === input.meterStartWh &&
                row.startedAt?.getTime() === input.startedAt.getTime(),
            );
            if (repeat !== undefined && repeat.transactionId !== null) {
              return { sessionId: repeat.id, transactionId: repeat.transactionId, created: false };
            }
            const transactionId = randomTransactionId();
            const values = {
              status: "charging" as const,
              ocppTransactionId: transactionId,
              meterStartWh: input.meterStartWh,
              startedAt: input.startedAt,
            };
            const starting = open.find(
              (row) => row.status === "starting" && row.transactionId === null,
            );
            let sessionId: string;
            if (starting === undefined) {
              const [inserted] = await tx
                .insert(sessions)
                .values({ bookingId: input.bookingId, ...values })
                .returning({ id: sessions.id });
              if (inserted === undefined) {
                throw new Error("session insert returned no row");
              }
              sessionId = inserted.id;
            } else {
              await tx.update(sessions).set(values).where(eq(sessions.id, starting.id));
              sessionId = starting.id;
            }
            await tx
              .update(bookings)
              .set({ status: "active" })
              .where(and(eq(bookings.id, input.bookingId), eq(bookings.status, "arrived")));
            await notify(
              tx,
              chargerEvent(charger, new Date(), {
                type: "session_started",
                sessionId,
                bookingId: input.bookingId,
                transactionId,
                meterStartWh: input.meterStartWh,
              }),
            );
            return { sessionId, transactionId, created: true };
          });
        } catch (error) {
          if (attempt >= TRANSACTION_ID_ATTEMPTS || !isUniqueViolation(error)) {
            throw error;
          }
        }
      }
    },

    recordMeterValues: (charger, transactionId, samples) =>
      db.transaction(async (tx) => {
        let session: { id: string; transactionId: number | null } | undefined;
        if (transactionId === undefined) {
          const open = await openTransactionForCharger(tx, charger.id);
          session =
            open === undefined
              ? undefined
              : { id: open.session.id, transactionId: open.session.ocppTransactionId };
        } else {
          const row = await sessionForTransaction(tx, charger.id, transactionId);
          session = row === undefined ? undefined : { id: row.id, transactionId };
        }
        const last = samples.at(-1);
        if (session === undefined || last === undefined) {
          return undefined;
        }
        await insertSamples(tx, session.id, samples);
        await notify(
          tx,
          chargerEvent(charger, new Date(), {
            type: "meter",
            sessionId: session.id,
            transactionId: session.transactionId,
            ts: last.ts.toISOString(),
            energyWh: last.energyWh,
            powerW: last.powerW,
          }),
        );
        return session.id;
      }),

    stopSession: (charger, input) =>
      db.transaction(async (tx) => {
        const row = await sessionForTransaction(tx, charger.id, input.transactionId);
        if (row === undefined) {
          return undefined;
        }
        if (!isOpenSession(row.status)) {
          return {
            sessionId: row.id,
            bookingId: row.bookingId,
            status: row.status,
            kwh: row.kwh,
            changed: false,
          };
        }
        await insertSamples(tx, row.id, input.samples);
        const kwh = deliveredKwh(row.meterStartWh ?? input.meterStopWh, input.meterStopWh);
        const status: SessionStatus = kwh === null ? "needs_review" : "stopped";
        await tx
          .update(sessions)
          .set({
            status,
            // The database refuses a stop reading below the start; keep it in the event and the log.
            meterStopWh: kwh === null ? null : input.meterStopWh,
            kwh,
            stoppedAt: input.stoppedAt,
            stopReason: input.reason,
          })
          .where(eq(sessions.id, row.id));
        await tx
          .update(bookings)
          .set({ status: "completed" })
          .where(and(eq(bookings.id, row.bookingId), eq(bookings.status, "active")));
        await notify(
          tx,
          chargerEvent(charger, new Date(), {
            type: "session_stopped",
            sessionId: row.id,
            bookingId: row.bookingId,
            transactionId: input.transactionId,
            sessionStatus: status,
            meterStopWh: input.meterStopWh,
            kwh,
            reason: input.reason,
          }),
        );
        return { sessionId: row.id, bookingId: row.bookingId, status, kwh, changed: true };
      }),

    markStaleChargersOffline: (cutoff, at) =>
      db.transaction(async (tx) => {
        const stale = await tx
          .update(chargers)
          .set({ status: "offline" })
          .where(
            and(
              inArray(chargers.status, ["online", "faulted"]),
              isNotNull(chargers.lastHeartbeatAt),
              lt(chargers.lastHeartbeatAt, cutoff),
            ),
          )
          .returning({
            id: chargers.id,
            chargeboxId: chargers.chargeboxId,
            lastHeartbeatAt: chargers.lastHeartbeatAt,
          });
        for (const charger of stale) {
          await notify(
            tx,
            chargerEvent(charger, at, {
              type: "offline",
              lastHeartbeatAt: charger.lastHeartbeatAt?.toISOString() ?? null,
            }),
          );
        }
        return stale.length;
      }),

    kwhCapReached: (sessionId) => kwhCapReached(db, sessionId),
  };
}
