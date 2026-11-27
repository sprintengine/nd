import { z } from "zod";

import { ciString, DateTime, IdTagInfo, IdToken, Integer, MeterValue } from "./common.ts";

/** Messages a charge point sends to the central system, with their responses (".conf"). */

// BootNotification

export const BootNotificationRequest = z.strictObject({
  chargePointVendor: ciString(20),
  chargePointModel: ciString(20),
  chargePointSerialNumber: ciString(25).optional(),
  chargeBoxSerialNumber: ciString(25).optional(),
  firmwareVersion: ciString(50).optional(),
  iccid: ciString(20).optional(),
  imsi: ciString(20).optional(),
  meterType: ciString(25).optional(),
  meterSerialNumber: ciString(25).optional(),
});
export type BootNotificationRequest = z.infer<typeof BootNotificationRequest>;

export const RegistrationStatus = z.enum(["Accepted", "Pending", "Rejected"]);
export type RegistrationStatus = z.infer<typeof RegistrationStatus>;

export const BootNotificationResponse = z.strictObject({
  status: RegistrationStatus,
  currentTime: DateTime,
  /** Heartbeat interval in seconds when Accepted; retry delay otherwise. */
  interval: Integer,
});
export type BootNotificationResponse = z.infer<typeof BootNotificationResponse>;

// Heartbeat

export const HeartbeatRequest = z.strictObject({});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

export const HeartbeatResponse = z.strictObject({ currentTime: DateTime });
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

// StatusNotification

export const ChargePointErrorCode = z.enum([
  "ConnectorLockFailure",
  "EVCommunicationError",
  "GroundFailure",
  "HighTemperature",
  "InternalError",
  "LocalListConflict",
  "NoError",
  "OtherError",
  "OverCurrentFailure",
  "PowerMeterFailure",
  "PowerSwitchFailure",
  "ReaderFailure",
  "ResetFailure",
  "UnderVoltage",
  "OverVoltage",
  "WeakSignal",
]);
export type ChargePointErrorCode = z.infer<typeof ChargePointErrorCode>;

export const ChargePointStatus = z.enum([
  "Available",
  "Preparing",
  "Charging",
  "SuspendedEVSE",
  "SuspendedEV",
  "Finishing",
  "Reserved",
  "Unavailable",
  "Faulted",
]);
export type ChargePointStatus = z.infer<typeof ChargePointStatus>;

export const StatusNotificationRequest = z.strictObject({
  connectorId: Integer,
  errorCode: ChargePointErrorCode,
  info: ciString(50).optional(),
  status: ChargePointStatus,
  timestamp: DateTime.optional(),
  vendorId: ciString(255).optional(),
  vendorErrorCode: ciString(50).optional(),
});
export type StatusNotificationRequest = z.infer<typeof StatusNotificationRequest>;

export const StatusNotificationResponse = z.strictObject({});
export type StatusNotificationResponse = z.infer<typeof StatusNotificationResponse>;

// Authorize

export const AuthorizeRequest = z.strictObject({ idTag: IdToken });
export type AuthorizeRequest = z.infer<typeof AuthorizeRequest>;

export const AuthorizeResponse = z.strictObject({ idTagInfo: IdTagInfo });
export type AuthorizeResponse = z.infer<typeof AuthorizeResponse>;

// StartTransaction

export const StartTransactionRequest = z.strictObject({
  connectorId: Integer,
  idTag: IdToken,
  /** Energy register at the start, in Wh. */
  meterStart: Integer,
  reservationId: Integer.optional(),
  timestamp: DateTime,
});
export type StartTransactionRequest = z.infer<typeof StartTransactionRequest>;

export const StartTransactionResponse = z.strictObject({
  idTagInfo: IdTagInfo,
  transactionId: Integer,
});
export type StartTransactionResponse = z.infer<typeof StartTransactionResponse>;

// StopTransaction

export const StopReason = z.enum([
  "EmergencyStop",
  "EVDisconnected",
  "HardReset",
  "Local",
  "Other",
  "PowerLoss",
  "Reboot",
  "Remote",
  "SoftReset",
  "UnlockCommand",
  "DeAuthorized",
]);
export type StopReason = z.infer<typeof StopReason>;

export const StopTransactionRequest = z.strictObject({
  idTag: IdToken.optional(),
  /** Energy register at the stop, in Wh. */
  meterStop: Integer,
  timestamp: DateTime,
  transactionId: Integer,
  reason: StopReason.optional(),
  transactionData: z.array(MeterValue).optional(),
});
export type StopTransactionRequest = z.infer<typeof StopTransactionRequest>;

export const StopTransactionResponse = z.strictObject({ idTagInfo: IdTagInfo.optional() });
export type StopTransactionResponse = z.infer<typeof StopTransactionResponse>;

// MeterValues

export const MeterValuesRequest = z.strictObject({
  connectorId: Integer,
  transactionId: Integer.optional(),
  meterValue: z.array(MeterValue),
});
export type MeterValuesRequest = z.infer<typeof MeterValuesRequest>;

export const MeterValuesResponse = z.strictObject({});
export type MeterValuesResponse = z.infer<typeof MeterValuesResponse>;

// DataTransfer

export const DataTransferRequest = z.strictObject({
  vendorId: ciString(255),
  messageId: ciString(50).optional(),
  data: z.string().optional(),
});
export type DataTransferRequest = z.infer<typeof DataTransferRequest>;

export const DataTransferStatus = z.enum([
  "Accepted",
  "Rejected",
  "UnknownMessageId",
  "UnknownVendorId",
]);
export type DataTransferStatus = z.infer<typeof DataTransferStatus>;

export const DataTransferResponse = z.strictObject({
  status: DataTransferStatus,
  data: z.string().optional(),
});
export type DataTransferResponse = z.infer<typeof DataTransferResponse>;
