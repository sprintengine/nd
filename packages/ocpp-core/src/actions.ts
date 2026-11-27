import type { z } from "zod";

import * as cs from "./schemas/central-system.ts";
import * as cp from "./schemas/charge-point.ts";

/** A request schema and its response (".conf") schema. */
export interface ActionSchemas {
  readonly request: z.ZodType;
  readonly response: z.ZodType;
}

/** Actions a charge point initiates (charger to central system), in the subset a Zappi uses. */
export const chargePointActions = {
  Authorize: { request: cp.AuthorizeRequest, response: cp.AuthorizeResponse },
  BootNotification: { request: cp.BootNotificationRequest, response: cp.BootNotificationResponse },
  DataTransfer: { request: cp.DataTransferRequest, response: cp.DataTransferResponse },
  Heartbeat: { request: cp.HeartbeatRequest, response: cp.HeartbeatResponse },
  MeterValues: { request: cp.MeterValuesRequest, response: cp.MeterValuesResponse },
  StartTransaction: { request: cp.StartTransactionRequest, response: cp.StartTransactionResponse },
  StatusNotification: {
    request: cp.StatusNotificationRequest,
    response: cp.StatusNotificationResponse,
  },
  StopTransaction: { request: cp.StopTransactionRequest, response: cp.StopTransactionResponse },
} as const satisfies Record<string, ActionSchemas>;

/** Actions the central system initiates (central system to charger), in the subset a Zappi uses. */
export const centralSystemActions = {
  ChangeConfiguration: {
    request: cs.ChangeConfigurationRequest,
    response: cs.ChangeConfigurationResponse,
  },
  GetConfiguration: { request: cs.GetConfigurationRequest, response: cs.GetConfigurationResponse },
  RemoteStartTransaction: {
    request: cs.RemoteStartTransactionRequest,
    response: cs.RemoteStartTransactionResponse,
  },
  RemoteStopTransaction: {
    request: cs.RemoteStopTransactionRequest,
    response: cs.RemoteStopTransactionResponse,
  },
  Reset: { request: cs.ResetRequest, response: cs.ResetResponse },
  TriggerMessage: { request: cs.TriggerMessageRequest, response: cs.TriggerMessageResponse },
  UnlockConnector: { request: cs.UnlockConnectorRequest, response: cs.UnlockConnectorResponse },
} as const satisfies Record<string, ActionSchemas>;

/** Every supported action, keyed by its OCPP action name. */
export const ocppActions = { ...chargePointActions, ...centralSystemActions } as const;

export type ChargePointAction = keyof typeof chargePointActions;
export type CentralSystemAction = keyof typeof centralSystemActions;
export type OcppAction = keyof typeof ocppActions;

export type ActionMap = Readonly<Record<string, ActionSchemas>>;

/** The validated request payload of `A`. */
export type OcppRequest<A extends OcppAction> = z.output<(typeof ocppActions)[A]["request"]>;
/** The validated response (".conf") payload of `A`. */
export type OcppResponse<A extends OcppAction> = z.output<(typeof ocppActions)[A]["response"]>;

export const CHARGE_POINT_ACTIONS = Object.keys(chargePointActions) as readonly ChargePointAction[];
export const CENTRAL_SYSTEM_ACTIONS = Object.keys(
  centralSystemActions,
) as readonly CentralSystemAction[];

export function isOcppAction(action: string): action is OcppAction {
  return Object.hasOwn(ocppActions, action);
}
