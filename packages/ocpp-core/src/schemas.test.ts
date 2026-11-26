import { describe, expect, it } from "vitest";

import {
  CENTRAL_SYSTEM_ACTIONS,
  CHARGE_POINT_ACTIONS,
  isOcppAction,
  ocppActions,
} from "./actions.ts";
import {
  ChangeConfigurationRequest,
  GetConfigurationResponse,
  RemoteStartTransactionRequest,
  ResetRequest,
  TriggerMessageRequest,
  UnlockConnectorResponse,
} from "./schemas/central-system.ts";
import {
  AuthorizeRequest,
  BootNotificationRequest,
  BootNotificationResponse,
  HeartbeatRequest,
  MeterValuesRequest,
  StartTransactionRequest,
  StatusNotificationRequest,
  StopTransactionRequest,
} from "./schemas/charge-point.ts";
import { DateTime, IdToken, UnitOfMeasure } from "./schemas/common.ts";

describe("action map", () => {
  it("covers the Zappi subset in both directions", () => {
    expect([...CHARGE_POINT_ACTIONS].sort()).toEqual([
      "Authorize",
      "BootNotification",
      "DataTransfer",
      "Heartbeat",
      "MeterValues",
      "StartTransaction",
      "StatusNotification",
      "StopTransaction",
    ]);
    expect([...CENTRAL_SYSTEM_ACTIONS].sort()).toEqual([
      "ChangeConfiguration",
      "GetConfiguration",
      "RemoteStartTransaction",
      "RemoteStopTransaction",
      "Reset",
      "TriggerMessage",
      "UnlockConnector",
    ]);
    expect(Object.keys(ocppActions)).toHaveLength(15);
  });

  it("recognises action names exactly", () => {
    expect(isOcppAction("Heartbeat")).toBe(true);
    expect(isOcppAction("heartbeat")).toBe(false);
    expect(isOcppAction("ReserveNow")).toBe(false);
    expect(isOcppAction("toString")).toBe(false);
  });
});

describe("common types", () => {
  it("limits idTag to 20 characters", () => {
    expect(IdToken.safeParse("x".repeat(20)).success).toBe(true);
    expect(IdToken.safeParse("x".repeat(21)).success).toBe(false);
    expect(AuthorizeRequest.safeParse({ idTag: "x".repeat(21) }).success).toBe(false);
  });

  it("accepts ISO timestamps with a zone and rejects others", () => {
    expect(DateTime.safeParse("2026-11-26T01:02:03Z").success).toBe(true);
    expect(DateTime.safeParse("2026-11-26T01:02:03.456+01:00").success).toBe(true);
    expect(DateTime.safeParse("2026-11-26T01:02:03").success).toBe(false);
    expect(DateTime.safeParse("26/11/2026").success).toBe(false);
  });

  it("accepts both spellings of Celsius", () => {
    expect(UnitOfMeasure.safeParse("Celcius").success).toBe(true);
    expect(UnitOfMeasure.safeParse("Celsius").success).toBe(true);
    expect(UnitOfMeasure.safeParse("celsius").success).toBe(false);
  });
});

describe("charge point messages", () => {
  it("validates BootNotification CiString limits and rejects unknown properties", () => {
    const boot = { chargePointVendor: "myenergi", chargePointModel: "Zappi" };
    expect(BootNotificationRequest.parse(boot)).toEqual(boot);
    expect(
      BootNotificationRequest.safeParse({ ...boot, chargePointModel: "x".repeat(21) }).success,
    ).toBe(false);
    expect(
      BootNotificationRequest.safeParse({ ...boot, firmwareVersion: "x".repeat(51) }).success,
    ).toBe(false);
    expect(BootNotificationRequest.safeParse({ ...boot, colour: "blue" }).success).toBe(false);
    expect(
      BootNotificationResponse.safeParse({
        status: "Accepted",
        currentTime: "2026-11-26T00:00:00Z",
        interval: 1.5,
      }).success,
    ).toBe(false);
    expect(
      BootNotificationResponse.safeParse({
        status: "accepted",
        currentTime: "2026-11-26T00:00:00Z",
        interval: 300,
      }).success,
    ).toBe(false);
  });

  it("takes an empty Heartbeat", () => {
    expect(HeartbeatRequest.parse({})).toEqual({});
    expect(HeartbeatRequest.safeParse({ a: 1 }).success).toBe(false);
  });

  it("validates StatusNotification enums", () => {
    const status = { connectorId: 1, errorCode: "NoError", status: "SuspendedEV" };
    expect(StatusNotificationRequest.safeParse(status).success).toBe(true);
    expect(StatusNotificationRequest.safeParse({ ...status, status: "Plugged" }).success).toBe(
      false,
    );
    expect(StatusNotificationRequest.safeParse({ ...status, errorCode: "Boom" }).success).toBe(
      false,
    );
  });

  it("validates transactions and meter values", () => {
    const at = "2026-11-26T00:00:00Z";
    expect(
      StartTransactionRequest.safeParse({
        connectorId: 1,
        idTag: "tag",
        meterStart: 100,
        timestamp: at,
      }).success,
    ).toBe(true);
    expect(
      StartTransactionRequest.safeParse({
        connectorId: 1,
        idTag: "tag",
        meterStart: 1.5,
        timestamp: at,
      }).success,
    ).toBe(false);
    expect(
      StopTransactionRequest.safeParse({
        meterStop: 1,
        timestamp: at,
        transactionId: 1,
        reason: "EVDisconnected",
      }).success,
    ).toBe(true);
    expect(
      StopTransactionRequest.safeParse({
        meterStop: 1,
        timestamp: at,
        transactionId: 1,
        reason: "Unplugged",
      }).success,
    ).toBe(false);
    expect(
      MeterValuesRequest.safeParse({
        connectorId: 1,
        transactionId: 7,
        meterValue: [
          {
            timestamp: at,
            sampledValue: [
              {
                value: "1234",
                measurand: "Energy.Active.Import.Register",
                unit: "Wh",
                context: "Sample.Periodic",
              },
              { value: "7200", measurand: "Power.Active.Import", unit: "W" },
            ],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      MeterValuesRequest.safeParse({
        connectorId: 1,
        meterValue: [{ timestamp: at, sampledValue: [{ value: 5 }] }],
      }).success,
    ).toBe(false);
  });
});

describe("central system messages", () => {
  it("validates RemoteStartTransaction, including a charging profile", () => {
    expect(RemoteStartTransactionRequest.safeParse({ idTag: "booking-1" }).success).toBe(true);
    expect(
      RemoteStartTransactionRequest.safeParse({
        connectorId: 1,
        idTag: "booking-1",
        chargingProfile: {
          chargingProfileId: 1,
          stackLevel: 0,
          chargingProfilePurpose: "TxProfile",
          chargingProfileKind: "Absolute",
          chargingSchedule: {
            chargingRateUnit: "A",
            chargingSchedulePeriod: [{ startPeriod: 0, limit: 16.5 }],
          },
        },
      }).success,
    ).toBe(true);
    expect(RemoteStartTransactionRequest.safeParse({}).success).toBe(false);
  });

  it("limits ChangeConfiguration key and value lengths", () => {
    expect(
      ChangeConfigurationRequest.safeParse({ key: "FreeCharging", value: "false" }).success,
    ).toBe(true);
    expect(ChangeConfigurationRequest.safeParse({ key: "k".repeat(51), value: "v" }).success).toBe(
      false,
    );
    expect(ChangeConfigurationRequest.safeParse({ key: "k", value: "v".repeat(501) }).success).toBe(
      false,
    );
  });

  it("validates the other requests and responses", () => {
    expect(
      GetConfigurationResponse.safeParse({
        configurationKey: [{ key: "HeartbeatInterval", readonly: false, value: "300" }],
        unknownKey: ["Nope"],
      }).success,
    ).toBe(true);
    expect(
      TriggerMessageRequest.safeParse({ requestedMessage: "MeterValues", connectorId: 1 }).success,
    ).toBe(true);
    expect(TriggerMessageRequest.safeParse({ requestedMessage: "Authorize" }).success).toBe(false);
    expect(ResetRequest.safeParse({ type: "Soft" }).success).toBe(true);
    expect(ResetRequest.safeParse({ type: "soft" }).success).toBe(false);
    expect(UnlockConnectorResponse.safeParse({ status: "NotSupported" }).success).toBe(true);
  });
});
