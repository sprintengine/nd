import {
  ChangeConfigurationResponse,
  GetConfigurationResponse,
  MessageTrigger,
  RemoteStartTransactionResponse,
  RemoteStopTransactionResponse,
  ResetResponse,
  TriggerMessageResponse,
  UnlockConnectorResponse,
} from "@nd/ocpp-core";
import { z } from "zod";

// The gateway's ChargerControl interface: commands the API sends to a
// connected charger over the gateway's internal HTTP endpoint. Each command is
// `POST <baseUrl>/v1/commands/<name>` with a JSON body and
// `Authorization: Bearer <shared secret>`; the answer is a ControlResult.

const chargeboxId = z.string().min(1).max(64);
/** OCPP idTag: at most 20 characters. */
const idTag = z.string().min(1).max(20);
const connectorId = z.int().positive();

/** Request and charger-response schemas of each ChargerControl command. */
export const chargerControlCommands = {
  remoteStart: {
    request: z.strictObject({ chargeboxId, idTag, connectorId: connectorId.optional() }),
    response: RemoteStartTransactionResponse,
  },
  remoteStop: {
    request: z.strictObject({ chargeboxId, transactionId: z.int() }),
    response: RemoteStopTransactionResponse,
  },
  changeConfiguration: {
    request: z.strictObject({
      chargeboxId,
      key: z.string().min(1).max(50),
      value: z.string().max(500),
    }),
    response: ChangeConfigurationResponse,
  },
  getConfiguration: {
    request: z.strictObject({ chargeboxId, keys: z.array(z.string().min(1).max(50)).optional() }),
    response: GetConfigurationResponse,
  },
  triggerMessage: {
    request: z.strictObject({
      chargeboxId,
      requestedMessage: MessageTrigger,
      connectorId: connectorId.optional(),
    }),
    response: TriggerMessageResponse,
  },
  /** Always a soft reset; a hard reset is never sent from the platform. */
  reset: {
    request: z.strictObject({ chargeboxId }),
    response: ResetResponse,
  },
  unlockConnector: {
    request: z.strictObject({ chargeboxId, connectorId: connectorId.optional() }),
    response: UnlockConnectorResponse,
  },
} as const;

export type ChargerControlCommand = keyof typeof chargerControlCommands;
export const CHARGER_CONTROL_COMMANDS = Object.keys(
  chargerControlCommands,
) as readonly ChargerControlCommand[];

export type ChargerControlRequest<C extends ChargerControlCommand> = z.input<
  (typeof chargerControlCommands)[C]["request"]
>;
export type ChargerControlResponse<C extends ChargerControlCommand> = z.output<
  (typeof chargerControlCommands)[C]["response"]
>;

/**
 * Why a command did not produce a charger response:
 *
 * - `offline`: the charger has no open socket to the gateway.
 * - `no_response`: the charger did not answer within the 30 s reply timeout.
 * - `call_error`: the charger answered with an OCPP CALLERROR (`errorCode`).
 * - `budget_exhausted`: a ChangeConfiguration would exceed the charger's
 *   write budget (24 per rolling hour).
 * - `send_failed`: the socket closed before the command could be sent.
 */
export const CONTROL_FAILURE_REASONS = [
  "offline",
  "no_response",
  "call_error",
  "budget_exhausted",
  "send_failed",
] as const;
export type ControlFailureReason = (typeof CONTROL_FAILURE_REASONS)[number];

const controlFailureSchema = z.strictObject({
  ok: z.literal(false),
  reason: z.enum(CONTROL_FAILURE_REASONS),
  message: z.string(),
  errorCode: z.string().optional(),
});
export type ControlFailure = z.infer<typeof controlFailureSchema>;

/** What a command came back with: the charger's response, or why there is none. */
export type ControlResult<R> = { readonly ok: true; readonly response: R } | ControlFailure;

/** Schema of the HTTP response body for `command`. */
export function controlResultSchema(command: ChargerControlCommand) {
  return z.discriminatedUnion("ok", [
    z.strictObject({ ok: z.literal(true), response: chargerControlCommands[command].response }),
    controlFailureSchema,
  ]);
}

/** The path a command is posted to, relative to the gateway's internal base URL. */
export function controlCommandPath(command: ChargerControlCommand): string {
  return `/v1/commands/${command}`;
}

/** The gateway's internal endpoint could not be reached or answered with an HTTP error. */
export class ChargerControlError extends Error {
  override readonly name = "ChargerControlError";
  /** HTTP status, when the gateway answered. */
  readonly status: number | undefined;

  constructor(message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.status = status;
  }
}

/** Typed ChargerControl client for the API. One method per command. */
export type ChargerControl = {
  readonly [C in ChargerControlCommand]: (
    request: ChargerControlRequest<C>,
  ) => Promise<ControlResult<ChargerControlResponse<C>>>;
};

export interface ChargerControlClientOptions {
  /** Base URL of the gateway's internal endpoint, such as `http://ocpp-gateway:9100`. */
  readonly baseUrl: string;
  /** The shared secret (`GATEWAY_INTERNAL_SECRET`). */
  readonly secret: string;
  /** Longest to wait for an answer. Defaults to 40 s, past the gateway's 30 s reply timeout. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
}

/** Default HTTP timeout of the client: longer than the gateway's own OCPP reply timeout. */
export const CONTROL_CLIENT_TIMEOUT_MS = 40_000;

/**
 * Creates a ChargerControl client. Commands resolve with a ControlResult;
 * they throw {@link ChargerControlError} only when the gateway itself cannot
 * be reached or rejects the request, which the caller may retry.
 */
export function createChargerControlClient(options: ChargerControlClientOptions): ChargerControl {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? CONTROL_CLIENT_TIMEOUT_MS;

  async function send<C extends ChargerControlCommand>(
    command: C,
    request: ChargerControlRequest<C>,
  ): Promise<ControlResult<ChargerControlResponse<C>>> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${controlCommandPath(command)}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.secret}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ChargerControlError(`Gateway unreachable for ${command}`, undefined, {
        cause: error,
      });
    }
    if (!response.ok) {
      throw new ChargerControlError(
        `Gateway answered ${command} with HTTP ${String(response.status)}`,
        response.status,
      );
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new ChargerControlError(`Gateway sent invalid JSON for ${command}`, response.status, {
        cause: error,
      });
    }
    const parsed = controlResultSchema(command).safeParse(body);
    if (!parsed.success) {
      throw new ChargerControlError(
        `Gateway sent an unexpected body for ${command}`,
        response.status,
      );
    }
    return parsed.data as ControlResult<ChargerControlResponse<C>>;
  }

  return Object.fromEntries(
    CHARGER_CONTROL_COMMANDS.map((command) => [
      command,
      (request: ChargerControlRequest<typeof command>) => send(command, request),
    ]),
  ) as unknown as ChargerControl;
}
