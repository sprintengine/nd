import { z } from "zod";

import { ChargingProfile, ciString, IdToken, Integer } from "./common.ts";

/** Messages the central system sends to a charge point, with their responses (".conf"). */

const AcceptedOrRejected = z.enum(["Accepted", "Rejected"]);

// RemoteStartTransaction

export const RemoteStartStopStatus = AcceptedOrRejected;
export type RemoteStartStopStatus = z.infer<typeof RemoteStartStopStatus>;

export const RemoteStartTransactionRequest = z.strictObject({
  connectorId: Integer.optional(),
  idTag: IdToken,
  chargingProfile: ChargingProfile.optional(),
});
export type RemoteStartTransactionRequest = z.infer<typeof RemoteStartTransactionRequest>;

export const RemoteStartTransactionResponse = z.strictObject({ status: RemoteStartStopStatus });
export type RemoteStartTransactionResponse = z.infer<typeof RemoteStartTransactionResponse>;

// RemoteStopTransaction

export const RemoteStopTransactionRequest = z.strictObject({ transactionId: Integer });
export type RemoteStopTransactionRequest = z.infer<typeof RemoteStopTransactionRequest>;

export const RemoteStopTransactionResponse = z.strictObject({ status: RemoteStartStopStatus });
export type RemoteStopTransactionResponse = z.infer<typeof RemoteStopTransactionResponse>;

// ChangeConfiguration

export const ChangeConfigurationRequest = z.strictObject({
  key: ciString(50),
  value: ciString(500),
});
export type ChangeConfigurationRequest = z.infer<typeof ChangeConfigurationRequest>;

export const ConfigurationStatus = z.enum([
  "Accepted",
  "Rejected",
  "RebootRequired",
  "NotSupported",
]);
export type ConfigurationStatus = z.infer<typeof ConfigurationStatus>;

export const ChangeConfigurationResponse = z.strictObject({ status: ConfigurationStatus });
export type ChangeConfigurationResponse = z.infer<typeof ChangeConfigurationResponse>;

// GetConfiguration

export const GetConfigurationRequest = z.strictObject({
  /** Keys to read; omitted or empty means every key. */
  key: z.array(ciString(50)).optional(),
});
export type GetConfigurationRequest = z.infer<typeof GetConfigurationRequest>;

export const KeyValue = z.strictObject({
  key: ciString(50),
  readonly: z.boolean(),
  value: ciString(500).optional(),
});
export type KeyValue = z.infer<typeof KeyValue>;

export const GetConfigurationResponse = z.strictObject({
  configurationKey: z.array(KeyValue).optional(),
  unknownKey: z.array(ciString(50)).optional(),
});
export type GetConfigurationResponse = z.infer<typeof GetConfigurationResponse>;

// TriggerMessage

export const MessageTrigger = z.enum([
  "BootNotification",
  "DiagnosticsStatusNotification",
  "FirmwareStatusNotification",
  "Heartbeat",
  "MeterValues",
  "StatusNotification",
]);
export type MessageTrigger = z.infer<typeof MessageTrigger>;

export const TriggerMessageRequest = z.strictObject({
  requestedMessage: MessageTrigger,
  connectorId: Integer.optional(),
});
export type TriggerMessageRequest = z.infer<typeof TriggerMessageRequest>;

export const TriggerMessageStatus = z.enum(["Accepted", "Rejected", "NotImplemented"]);
export type TriggerMessageStatus = z.infer<typeof TriggerMessageStatus>;

export const TriggerMessageResponse = z.strictObject({ status: TriggerMessageStatus });
export type TriggerMessageResponse = z.infer<typeof TriggerMessageResponse>;

// Reset

export const ResetType = z.enum(["Hard", "Soft"]);
export type ResetType = z.infer<typeof ResetType>;

export const ResetRequest = z.strictObject({ type: ResetType });
export type ResetRequest = z.infer<typeof ResetRequest>;

export const ResetStatus = AcceptedOrRejected;
export type ResetStatus = z.infer<typeof ResetStatus>;

export const ResetResponse = z.strictObject({ status: ResetStatus });
export type ResetResponse = z.infer<typeof ResetResponse>;

// UnlockConnector

export const UnlockConnectorRequest = z.strictObject({ connectorId: Integer });
export type UnlockConnectorRequest = z.infer<typeof UnlockConnectorRequest>;

export const UnlockStatus = z.enum(["Unlocked", "UnlockFailed", "NotSupported"]);
export type UnlockStatus = z.infer<typeof UnlockStatus>;

export const UnlockConnectorResponse = z.strictObject({ status: UnlockStatus });
export type UnlockConnectorResponse = z.infer<typeof UnlockConnectorResponse>;
