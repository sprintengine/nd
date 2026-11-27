import type { ChargePointAction, InboundHandlers } from "@nd/ocpp-core";

import {
  applyBootConfig,
  type ConfigTarget,
  type ConfigWriteBudget,
  HEARTBEAT_INTERVAL_SECONDS,
} from "./boot-config.ts";
import type { ChargerConnection } from "./connection.ts";
import { kwhCapGuard } from "./kwh-cap.ts";
import type { Logger } from "./logger.ts";
import { extractMeterSamples } from "./meter.ts";
import { authorizationStatus, decideIdTag, randomTransactionId } from "./rules.ts";
import type { GatewayStore } from "./store.ts";

export interface HandlerContext {
  readonly connection: Pick<ChargerConnection, "charger" | "afterReply" | "call">;
  readonly store: GatewayStore;
  readonly budget: ConfigWriteBudget;
  readonly logger: Logger;
  readonly heartbeatIntervalSeconds?: number;
  readonly now?: () => Date;
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Answers for every charger-initiated action. Each handler writes what it
 * learned before it returns, so the CALLRESULT goes out only once that is
 * stored. Calls back to the charger (configuration on boot, stopping a
 * blocked session) run after the reply has been sent, never inside a handler.
 */
export function chargePointHandlers(context: HandlerContext): InboundHandlers<ChargePointAction> {
  const { connection, store, logger, budget } = context;
  const { charger } = connection;
  const interval = context.heartbeatIntervalSeconds ?? HEARTBEAT_INTERVAL_SECONDS;
  const now = context.now ?? (() => new Date());
  let configuring = false;
  const kwhCap = kwhCapGuard({ connection, store, logger });

  const pushConfig = () => {
    if (configuring) {
      return;
    }
    configuring = true;
    applyBootConfig(connection as ConfigTarget, {
      store,
      budget,
      logger,
      heartbeatIntervalSeconds: interval,
    })
      .catch((error: unknown) => {
        logger.error({ err: errorMessage(error) }, "boot configuration failed");
      })
      .finally(() => {
        configuring = false;
      });
  };

  return {
    async BootNotification(request, { messageId }) {
      const at = now();
      await store.recordBoot(charger, request.firmwareVersion ?? null, at);
      logger.info(
        { model: request.chargePointModel, firmware: request.firmwareVersion },
        "charger booted",
      );
      connection.afterReply(messageId, pushConfig);
      return { status: "Accepted", currentTime: at.toISOString(), interval };
    },

    async Heartbeat() {
      const at = now();
      await store.recordHeartbeat(charger, at);
      return { currentTime: at.toISOString() };
    },

    async StatusNotification(request) {
      const outcome = await store.recordStatus(
        charger,
        {
          connectorId: request.connectorId,
          status: request.status,
          errorCode: request.errorCode,
          info: request.info,
          vendorErrorCode: request.vendorErrorCode,
        },
        now(),
      );
      logger.info(
        {
          connectorId: request.connectorId,
          status: request.status,
          errorCode: request.errorCode,
          chargerStatus: outcome.chargerStatus,
          sessionStatus: outcome.session?.status,
        },
        "status notification",
      );
      return {};
    },

    async Authorize(request) {
      const decision = decideIdTag(
        request.idTag,
        await store.tagFacts(charger.id, request.idTag, now()),
      );
      const status = authorizationStatus(decision);
      logger.info({ kind: decision.kind, status }, "authorize");
      return { idTagInfo: { status } };
    },

    async StartTransaction(request, { messageId }) {
      const decision = decideIdTag(
        request.idTag,
        await store.tagFacts(charger.id, request.idTag, now()),
      );
      if (decision.kind === "booking") {
        const started = await store.startBookingSession(charger, {
          bookingId: decision.bookingId,
          meterStartWh: request.meterStart,
          startedAt: new Date(request.timestamp),
        });
        logger.info(
          {
            sessionId: started.sessionId,
            transactionId: started.transactionId,
            repeat: !started.created,
          },
          "booking session started",
        );
        return { idTagInfo: { status: "Accepted" }, transactionId: started.transactionId };
      }
      // Host and refused sessions have no session row; ocpp_messages keeps the evidence.
      const transactionId = randomTransactionId();
      const status = authorizationStatus(decision);
      logger.info({ kind: decision.kind, status, transactionId }, "non-booking transaction");
      if (decision.kind === "host" && decision.blocked) {
        connection.afterReply(messageId, () => {
          void connection.call("RemoteStopTransaction", { transactionId }).then((result) => {
            logger.info(
              { transactionId, result: result.ok ? result.response.status : result.reason },
              "stopped a host session inside a paid window",
            );
          });
        });
      }
      return { idTagInfo: { status }, transactionId };
    },

    async MeterValues(request, { messageId }) {
      const samples = extractMeterSamples(request.meterValue);
      const sessionId = await store.recordMeterValues(charger, request.transactionId, samples);
      if (sessionId === undefined) {
        logger.debug(
          { transactionId: request.transactionId },
          "meter values without a booking session",
        );
      } else {
        await kwhCap.check(sessionId, messageId);
      }
      return {};
    },

    async StopTransaction(request) {
      const stopped = await store.stopSession(charger, {
        transactionId: request.transactionId,
        meterStopWh: request.meterStop,
        stoppedAt: new Date(request.timestamp),
        // OCPP: an absent reason means Local.
        reason: request.reason ?? "Local",
        samples: extractMeterSamples(request.transactionData ?? []),
      });
      logger.info(
        {
          transactionId: request.transactionId,
          sessionId: stopped?.sessionId,
          status: stopped?.status,
          kwh: stopped?.kwh,
          repeat: stopped === undefined ? undefined : !stopped.changed,
        },
        stopped === undefined ? "non-booking transaction stopped" : "booking session stopped",
      );
      return request.idTag === undefined ? {} : { idTagInfo: { status: "Accepted" } };
    },

    DataTransfer(request) {
      logger.info(
        { vendorId: request.vendorId, dataMessageId: request.messageId },
        "data transfer ignored",
      );
      return { status: "UnknownVendorId" };
    },
  };
}
