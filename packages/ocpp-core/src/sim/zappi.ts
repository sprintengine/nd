import { EventEmitter } from "node:events";

import { WebSocket } from "ws";

import type {
  CentralSystemAction,
  ChargePointAction,
  OcppRequest,
  OcppResponse,
} from "../actions.ts";
import { type Frame, type JsonObject, MessageTypeId, parseFrame } from "../framing.ts";
import { OCPP16_SUBPROTOCOL } from "../index.ts";
import { type ChargePointPeer, createChargePointPeer, DEFAULT_CALL_TIMEOUT_MS } from "../rpc.ts";
import type {
  BootNotificationResponse,
  ChargePointErrorCode,
  ChargePointStatus,
  RegistrationStatus,
  StopReason,
} from "../schemas/charge-point.ts";
import type { ReadingContext } from "../schemas/common.ts";
import {
  ConfigStore,
  type OcppChargeMode,
  type ZappiConfig,
  type ZappiConfigKey,
} from "./config.ts";

/** Faults a test can switch on to make the simulated charger misbehave. */
export interface FaultScript {
  /** Delay before each inbound CALL is processed and answered, in ms. */
  readonly replyDelayMs: number;
  /** Inbound CALLs that are silently dropped and never answered. */
  readonly ignoreCalls:
    readonly CentralSystemAction[] | ((action: string, payload: JsonObject) => boolean);
  /** Start charging locally but never tell the central system with StartTransaction. */
  readonly neverSendStartTransaction: boolean;
  /** End transactions locally but never send StopTransaction. */
  readonly neverSendStopTransaction: boolean;
}

const NO_FAULTS: FaultScript = {
  replyDelayMs: 0,
  ignoreCalls: [],
  neverSendStartTransaction: false,
  neverSendStopTransaction: false,
};

export interface ZappiSimOptions {
  /** Central system URL the chargebox id is appended to, such as `ws://localhost:9000/v16/`. */
  readonly url: string;
  readonly chargeboxId: string;
  /** HTTP Basic Auth password (the username is the chargebox id). Omit to send no credentials. */
  readonly secret?: string;
  readonly vendor?: string;
  readonly model?: string;
  readonly serialNumber?: string;
  readonly firmwareVersion?: string;
  /** Charging power while Charging, in kW. Defaults to 7.2. */
  readonly chargeRateKw?: number;
  /** Delay between being unlocked with the car plugged in and StartTransaction, in ms. Defaults to 1000. */
  readonly startDelayMs?: number;
  /** Energy register at start-up, in Wh. */
  readonly meterWh?: number;
  readonly config?: Partial<ZappiConfig>;
  readonly configWriteLimit?: number;
  readonly configWriteWindowMs?: number;
  /** Reply timeout for the charger's own calls, in ms. Defaults to 30 s. */
  readonly callTimeoutMs?: number;
  /** Reconnect this long after the socket drops unexpectedly. Off by default. */
  readonly autoReconnectMs?: number;
  /** How long a Reset keeps the charger offline, in ms. Defaults to 1000. */
  readonly resetDelayMs?: number;
  /** idTag used for transactions started by FreeCharging. */
  readonly freeChargingIdTag?: string;
  /** A tethered charger cannot unlock its connector. */
  readonly tethered?: boolean;
  readonly faults?: Partial<FaultScript>;
  /** Verify the server's TLS certificate (wss). Defaults to true. */
  readonly rejectUnauthorized?: boolean;
  /** Receives a line for each notable event. */
  readonly log?: (line: string) => void;
}

export interface SimFrame {
  readonly direction: "in" | "out";
  readonly frame: Frame;
  readonly raw: string;
  readonly at: number;
}

export interface SimTransaction {
  /** Undefined until the central system answers StartTransaction (or forever, with neverSendStartTransaction). */
  readonly id: number | undefined;
  readonly idTag: string;
  readonly meterStart: number;
  readonly startedAt: string;
}

export interface ZappiSimState {
  readonly connected: boolean;
  readonly registration: RegistrationStatus | "None";
  readonly status: ChargePointStatus;
  readonly errorCode: ChargePointErrorCode;
  readonly plugged: boolean;
  /** "Stop" while the charger is locked; otherwise the configured OCPPChargeMode. */
  readonly chargeMode: OcppChargeMode;
  readonly meterWh: number;
  readonly powerW: number;
  readonly transaction: SimTransaction | undefined;
  readonly config: ZappiConfig;
}

export interface ZappiSimEvents {
  frame: [SimFrame];
  status: [{ status: ChargePointStatus; errorCode: ChargePointErrorCode }];
  connected: [];
  disconnected: [{ code: number; reason: string }];
  booted: [BootNotificationResponse];
  transactionStarted: [SimTransaction];
  transactionStopped: [{ transaction: SimTransaction; meterStop: number; reason: StopReason }];
  ignored: [{ action: string; messageId: string }];
  /** Failures the simulator survives: rejected or timed-out calls, protocol errors. */
  problem: [Error];
}

/** The socket closed, so a call could not be sent or answered. */
export class SimDisconnectedError extends Error {
  override readonly name = "SimDisconnectedError";
  constructor() {
    super("The simulator is not connected");
  }
}

/** The simulator was stopped. */
export class SimStoppedError extends Error {
  override readonly name = "SimStoppedError";
  constructor() {
    super("The simulator was stopped");
  }
}

/** The WebSocket upgrade failed; `statusCode` is set when the server answered with an HTTP error. */
export class ZappiConnectError extends Error {
  override readonly name = "ZappiConnectError";
  readonly statusCode: number | undefined;
  constructor(message: string, statusCode: number | undefined) {
    super(message);
    this.statusCode = statusCode;
  }
}

interface MutableTransaction {
  id: number | undefined;
  readonly idTag: string;
  readonly meterStart: number;
  readonly startedAt: string;
  /** The central system did not accept the idTag and StopTransactionOnInvalidId is false. */
  suspendedByEvse: boolean;
}

interface SendOptions<A extends ChargePointAction> {
  /** Kept and retried across disconnects, as transaction messages must be. */
  readonly persistent?: boolean;
  /** Runs before the next queued call is sent. */
  readonly onResponse?: (response: OcppResponse<A>) => void;
}

type Timer = ReturnType<typeof setTimeout>;

const CONNECTOR_ID = 1;

function snapshot(transaction: MutableTransaction): SimTransaction {
  return {
    id: transaction.id,
    idTag: transaction.idTag,
    meterStart: transaction.meterStart,
    startedAt: transaction.startedAt,
  };
}

/** Decodes a ws text message. */
export function rawDataToString(data: WebSocket.RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(data)).toString("utf8");
  }
  return data.toString("utf8");
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * A myenergi Zappi speaking OCPP 1.6J the way myenergi's cloud does on its
 * behalf: it connects out to `<url><chargeboxId>` with HTTP Basic Auth and the
 * `ocpp1.6` subprotocol, boots, heartbeats and reports status changes, and
 * runs transactions when unlocked. It has one connector.
 *
 * Timers use the global `setTimeout` and `Date.now()`, so Vitest fake timers
 * drive heartbeats, meter values and delays.
 */
export class ZappiSim extends EventEmitter<ZappiSimEvents> {
  readonly chargeboxId: string;
  readonly url: string;
  readonly config: ConfigStore;
  /** Every frame sent and received, in order. */
  readonly frames: SimFrame[] = [];
  faults: FaultScript;

  readonly #options: ZappiSimOptions;
  readonly #peer: ChargePointPeer;
  readonly #afterReply = new Map<string, () => void>();
  #ws: WebSocket | undefined;
  #intentionalClose = false;
  #stopped = false;
  #registration: RegistrationStatus | "None" = "None";
  #online = false;
  #onlineWaiters: { resolve: () => void; reject: (error: Error) => void }[] = [];
  #chain: Promise<unknown> = Promise.resolve();

  #status: ChargePointStatus = "Available";
  #errorCode: ChargePointErrorCode = "NoError";
  #faultInfo: string | undefined;
  #faulted = false;
  #plugged = false;
  #finishing = false;
  #evDrawing = true;
  #authorizedIdTag: string | undefined;
  #transaction: MutableTransaction | undefined;
  #meterWh: number;
  #meterUpdatedAt = Date.now();

  #heartbeatTimer: Timer | undefined;
  #meterTimer: Timer | undefined;
  #startTimer: Timer | undefined;
  #bootRetryTimer: Timer | undefined;
  #reconnectTimer: Timer | undefined;

  constructor(options: ZappiSimOptions) {
    super();
    this.#options = options;
    this.chargeboxId = options.chargeboxId;
    this.url = `${options.url}${encodeURIComponent(options.chargeboxId)}`;
    this.#meterWh = options.meterWh ?? 0;
    this.faults = { ...NO_FAULTS, ...options.faults };
    this.config = new ConfigStore({
      ...(options.config === undefined ? {} : { initial: options.config }),
      ...(options.configWriteLimit === undefined ? {} : { writeLimit: options.configWriteLimit }),
      ...(options.configWriteWindowMs === undefined
        ? {}
        : { writeWindowMs: options.configWriteWindowMs }),
    });
    this.#peer = createChargePointPeer({
      send: (text, frame) => {
        this.#transmit(text, frame);
      },
      timeoutMs: options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      onProtocolError: (error) => {
        this.#problem(error instanceof Error ? error : new Error(error.description));
      },
    });
    this.#registerHandlers();
  }

  // ---------------------------------------------------------------------------
  // State and assertion hooks

  get state(): ZappiSimState {
    this.#accrue();
    return {
      connected: this.#ws?.readyState === WebSocket.OPEN,
      registration: this.#registration,
      status: this.#status,
      errorCode: this.#errorCode,
      plugged: this.#plugged,
      chargeMode: this.#chargeMode(),
      meterWh: Math.round(this.#meterWh),
      powerW: this.#powerW(),
      transaction: this.#transaction === undefined ? undefined : snapshot(this.#transaction),
      config: this.config.values,
    };
  }

  /** Payloads of the CALLs the charger sent for `action`, oldest first. */
  sent<A extends ChargePointAction>(action: A): OcppRequest<A>[] {
    return this.#calls("out", action) as OcppRequest<A>[];
  }

  /** Payloads of the CALLs the charger received for `action`, oldest first. */
  received<A extends CentralSystemAction>(action: A): OcppRequest<A>[] {
    return this.#calls("in", action) as OcppRequest<A>[];
  }

  /**
   * Resolves with the first CALL for `action` the charger sends at or after
   * frame index `since` (default: any time) that matches `predicate`.
   * Use `sim.frames.length` as `since` to wait for the next one.
   */
  waitForSent<A extends ChargePointAction>(
    action: A,
    options: {
      predicate?: (payload: OcppRequest<A>) => boolean;
      since?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<OcppRequest<A>> {
    const matches = (entry: SimFrame): OcppRequest<A> | undefined => {
      const { frame } = entry;
      if (
        entry.direction !== "out" ||
        frame.type !== MessageTypeId.Call ||
        frame.action !== action
      ) {
        return undefined;
      }
      const payload = frame.payload as OcppRequest<A>;
      return options.predicate === undefined || options.predicate(payload) ? payload : undefined;
    };
    for (const entry of this.frames.slice(options.since ?? 0)) {
      const payload = matches(entry);
      if (payload !== undefined) {
        return Promise.resolve(payload);
      }
    }
    return this.#waitForEvent("frame", `${action} to be sent`, options.timeoutMs, (entry) =>
      matches(entry),
    );
  }

  /** Resolves once the connector reports `status` (immediately if it already does). */
  waitForStatus(status: ChargePointStatus, timeoutMs?: number): Promise<void> {
    if (this.#status === status) {
      return Promise.resolve();
    }
    return this.#waitForEvent("status", `status ${status}`, timeoutMs, (change) =>
      change.status === status ? true : undefined,
    ).then(() => undefined);
  }

  /** Resolves once the socket closes. */
  waitForDisconnect(timeoutMs?: number): Promise<{ code: number; reason: string }> {
    return this.#waitForEvent("disconnected", "disconnect", timeoutMs, (event) => event);
  }

  // ---------------------------------------------------------------------------
  // Controls

  /** Connects and sends BootNotification. Resolves with the central system's answer. */
  async connect(options: { boot?: boolean } = {}): Promise<BootNotificationResponse | undefined> {
    if (this.#stopped) {
      throw new SimStoppedError();
    }
    if (this.#ws !== undefined) {
      throw new Error("The simulator is already connected");
    }
    this.#intentionalClose = false;
    clearTimeout(this.#reconnectTimer);
    await this.#open();
    if (options.boot === false) {
      this.#goOnline();
      return undefined;
    }
    return this.#boot();
  }

  /** Drops the socket without a closing handshake, as a lost connection would. No automatic reconnect. */
  disconnect(): void {
    this.#intentionalClose = true;
    this.#ws?.terminate();
  }

  /** Drops the socket if open, then connects again; `boot: false` skips BootNotification. */
  async reconnect(options: { boot?: boolean } = {}): Promise<BootNotificationResponse | undefined> {
    const ws = this.#ws;
    if (ws !== undefined) {
      const closed = this.waitForDisconnect();
      this.disconnect();
      await closed;
    }
    return this.connect(options);
  }

  /** Closes the connection cleanly and stops every timer. The simulator cannot be restarted. */
  async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    this.#intentionalClose = true;
    for (const timer of [
      this.#heartbeatTimer,
      this.#meterTimer,
      this.#startTimer,
      this.#bootRetryTimer,
      this.#reconnectTimer,
    ]) {
      clearTimeout(timer);
    }
    this.#rejectOnlineWaiters(new SimStoppedError());
    const ws = this.#ws;
    if (ws !== undefined) {
      if (ws.readyState === WebSocket.OPEN) {
        const closed = this.waitForDisconnect();
        ws.close(1000, "simulator stopped");
        await closed;
      } else {
        ws.terminate();
      }
    }
    this.#peer.cancelAll(new SimStoppedError());
  }

  /** The driver plugs a car in. */
  plugIn(): void {
    if (this.#plugged) {
      return;
    }
    this.#plugged = true;
    this.#finishing = false;
    this.#evDrawing = true;
    if (this.config.get("FreeCharging")) {
      this.#authorizedIdTag ??= this.#options.freeChargingIdTag ?? "FreeCharging";
    }
    this.#log("car plugged in");
    this.#updateStatus();
    this.#scheduleStart();
  }

  /**
   * The driver unplugs. An open transaction ends with StopTransaction
   * (EVDisconnected) and the connector returns to Available. The charger
   * locks again, so the next session needs a new authorisation unless
   * FreeCharging is on.
   */
  unplug(): void {
    if (!this.#plugged) {
      return;
    }
    this.#plugged = false;
    this.#finishing = false;
    this.#cancelStart();
    this.#log("car unplugged");
    this.#stopTransaction("EVDisconnected");
    this.#authorizedIdTag = undefined;
    this.#updateStatus();
  }

  /**
   * Someone enters a PIN (or presents a tag) on the charger. Sends
   * Authorize(idTag); Accepted unlocks the charger. A rejected tag stops an
   * open transaction when StopTransactionOnInvalidId is true, and suspends it
   * otherwise.
   */
  async enterPin(idTag: string): Promise<OcppResponse<"Authorize">> {
    const response = await this.#send("Authorize", { idTag });
    const accepted = response.idTagInfo.status === "Accepted";
    this.#log(`Authorize ${idTag}: ${response.idTagInfo.status}`);
    const transaction = this.#transaction;
    if (transaction !== undefined) {
      if (!accepted) {
        this.#rejectTransactionTag(transaction);
      }
    } else if (accepted) {
      this.#authorizedIdTag = idTag;
      this.#scheduleStart();
      this.#updateStatus();
    }
    return response;
  }

  /** The car stops drawing power (full, or its own timer): SuspendedEV. */
  suspendEv(): void {
    this.#evDrawing = false;
    this.#updateStatus();
  }

  /** The car draws power again. */
  resumeEv(): void {
    this.#evDrawing = true;
    this.#updateStatus();
  }

  /** The charger reports Faulted with `errorCode`. Remote starts are refused until {@link clearFault}. */
  fault(errorCode: Exclude<ChargePointErrorCode, "NoError"> = "OtherError", info?: string): void {
    this.#faulted = true;
    this.#errorCode = errorCode;
    this.#faultInfo = info;
    this.#cancelStart();
    this.#updateStatus();
  }

  clearFault(): void {
    this.#faulted = false;
    this.#errorCode = "NoError";
    this.#faultInfo = undefined;
    this.#updateStatus();
    this.#scheduleStart();
  }

  /** Switches fault scripts on or off. */
  setFaults(faults: Partial<FaultScript>): void {
    this.faults = { ...this.faults, ...faults };
  }

  /** Sends a DataTransfer and returns the answer. */
  dataTransfer(request: OcppRequest<"DataTransfer">): Promise<OcppResponse<"DataTransfer">> {
    return this.#send("DataTransfer", request);
  }

  /** Sends a Heartbeat now. */
  heartbeat(): Promise<OcppResponse<"Heartbeat">> {
    return this.#send("Heartbeat", {});
  }

  /** Sends MeterValues now (outside the periodic schedule). */
  sendMeterValues(context: ReadingContext = "Trigger"): Promise<OcppResponse<"MeterValues">> {
    return this.#sendMeterValues(context);
  }

  // ---------------------------------------------------------------------------
  // Connection

  #open(): Promise<void> {
    const { secret, rejectUnauthorized } = this.#options;
    const headers: Record<string, string> =
      secret === undefined
        ? {}
        : {
            Authorization: `Basic ${Buffer.from(`${this.chargeboxId}:${secret}`).toString("base64")}`,
          };
    const ws = new WebSocket(this.url, [OCPP16_SUBPROTOCOL], {
      headers,
      ...(rejectUnauthorized === undefined ? {} : { rejectUnauthorized }),
    });
    this.#ws = ws;
    ws.on("message", (data) => {
      this.#receive(rawDataToString(data));
    });
    ws.on("close", (code, reason) => {
      this.#onClose(ws, code, reason.toString("utf8"));
    });
    return new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.off("error", onError);
        ws.on("error", (error) => {
          this.#problem(error);
        });
        this.#log(`connected to ${this.url}`);
        this.emit("connected");
        resolve();
      };
      const onError = (error: Error) => {
        ws.off("open", onOpen);
        if (this.#ws === ws) {
          this.#ws = undefined;
        }
        const status = /Unexpected server response: (\d{3})/.exec(error.message)?.[1];
        reject(
          new ZappiConnectError(error.message, status === undefined ? undefined : Number(status)),
        );
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });
  }

  #onClose(ws: WebSocket, code: number, reason: string): void {
    if (ws !== this.#ws) {
      return;
    }
    this.#ws = undefined;
    this.#online = false;
    clearTimeout(this.#heartbeatTimer);
    clearTimeout(this.#bootRetryTimer);
    this.#afterReply.clear();
    this.#peer.cancelAll(new SimDisconnectedError());
    this.#log(`disconnected (${String(code)}${reason === "" ? "" : `, ${reason}`})`);
    this.emit("disconnected", { code, reason });
    const delay = this.#options.autoReconnectMs;
    if (!this.#intentionalClose && !this.#stopped && delay !== undefined) {
      this.#scheduleReconnect(delay);
    }
  }

  /** Reconnects after `delay` ms, and keeps trying while the central system is unreachable. */
  #scheduleReconnect(delay: number): void {
    this.#reconnectTimer = setTimeout(() => {
      this.connect().catch((error: unknown) => {
        this.#problem(toError(error));
        if (this.#ws === undefined && !this.#stopped && !this.#intentionalClose) {
          this.#scheduleReconnect(delay);
        }
      });
    }, delay);
  }

  async #boot(): Promise<BootNotificationResponse> {
    clearTimeout(this.#bootRetryTimer);
    const { vendor, model, serialNumber, firmwareVersion } = this.#options;
    const response = await this.#peer.call("BootNotification", {
      chargePointVendor: vendor ?? "myenergi",
      chargePointModel: model ?? "Zappi",
      chargePointSerialNumber: serialNumber ?? this.chargeboxId.slice(0, 25),
      firmwareVersion: firmwareVersion ?? "5.794",
    });
    this.#registration = response.status;
    this.#log(`BootNotification: ${response.status}, interval ${String(response.interval)} s`);
    this.emit("booted", response);
    if (response.status === "Accepted") {
      if (response.interval > 0) {
        this.config.setInternal("HeartbeatInterval", response.interval);
      }
      this.#goOnline();
    } else {
      const retrySeconds = response.interval > 0 ? response.interval : 60;
      this.#bootRetryTimer = setTimeout(() => {
        this.#boot().catch((error: unknown) => {
          this.#problem(toError(error));
        });
      }, retrySeconds * 1000);
    }
    return response;
  }

  #goOnline(): void {
    this.#registration = "Accepted";
    this.#online = true;
    for (const waiter of this.#onlineWaiters.splice(0)) {
      waiter.resolve();
    }
    this.#sendStatus();
    this.#scheduleHeartbeat();
    if (this.#transaction !== undefined && this.#meterTimer === undefined) {
      this.#scheduleMeterValues();
    }
  }

  #waitOnline(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#onlineWaiters.push({ resolve, reject });
    });
  }

  #rejectOnlineWaiters(error: Error): void {
    for (const waiter of this.#onlineWaiters.splice(0)) {
      waiter.reject(error);
    }
  }

  #transmit(text: string, frame: Frame): void {
    const ws = this.#ws;
    if (ws?.readyState !== WebSocket.OPEN) {
      throw new SimDisconnectedError();
    }
    ws.send(text);
    this.#record("out", frame, text);
    if (frame.type !== MessageTypeId.Call) {
      const after = this.#afterReply.get(frame.messageId);
      this.#afterReply.delete(frame.messageId);
      after?.();
    }
  }

  #receive(text: string): void {
    const parsed = parseFrame(text);
    if (parsed.ok) {
      this.#record("in", parsed.frame, text);
      const { frame } = parsed;
      if (frame.type === MessageTypeId.Call) {
        const { ignoreCalls, replyDelayMs } = this.faults;
        const ignored =
          typeof ignoreCalls === "function"
            ? ignoreCalls(frame.action, frame.payload)
            : (ignoreCalls as readonly string[]).includes(frame.action);
        if (ignored) {
          this.#log(`ignoring ${frame.action}`);
          this.emit("ignored", { action: frame.action, messageId: frame.messageId });
          return;
        }
        if (replyDelayMs > 0) {
          setTimeout(() => {
            void this.#peer.handleMessage(text);
          }, replyDelayMs);
          return;
        }
      }
    }
    void this.#peer.handleMessage(text);
  }

  #record(direction: SimFrame["direction"], frame: Frame, raw: string): void {
    const entry: SimFrame = { direction, frame, raw, at: Date.now() };
    this.frames.push(entry);
    this.emit("frame", entry);
  }

  /**
   * Queues one outbound CALL. OCPP allows one outstanding CALL per side, so
   * calls go out one at a time in order. A payload function is evaluated when
   * the call is sent and may return undefined to skip it.
   */
  #send<A extends ChargePointAction>(
    action: A,
    payload: OcppRequest<A> | (() => OcppRequest<A> | undefined),
    options: SendOptions<A> = {},
  ): Promise<OcppResponse<A>> {
    const run = async (): Promise<OcppResponse<A>> => {
      for (;;) {
        if (this.#stopped) {
          throw new SimStoppedError();
        }
        if (!this.#online) {
          if (options.persistent !== true) {
            throw new SimDisconnectedError();
          }
          await this.#waitOnline();
          continue;
        }
        const request = typeof payload === "function" ? payload() : payload;
        if (request === undefined) {
          return undefined as unknown as OcppResponse<A>;
        }
        try {
          const response = await this.#peer.call(action, request);
          options.onResponse?.(response);
          return response;
        } catch (error) {
          if (options.persistent === true && error instanceof SimDisconnectedError) {
            continue;
          }
          throw error;
        }
      }
    };
    const result = this.#chain.then(run);
    this.#chain = result.catch(() => undefined);
    return result;
  }

  /** Fire-and-forget send whose failure is reported as a problem. */
  #post<A extends ChargePointAction>(
    action: A,
    payload: OcppRequest<A> | (() => OcppRequest<A> | undefined),
    options: SendOptions<A> = {},
  ): void {
    this.#send(action, payload, options).catch((error: unknown) => {
      if (!(error instanceof SimStoppedError) && !(error instanceof SimDisconnectedError)) {
        this.#problem(toError(error));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Inbound calls

  #registerHandlers(): void {
    const peer = this.#peer;

    peer.handle("RemoteStartTransaction", (request, { messageId }) => {
      const wrongConnector =
        request.connectorId !== undefined && request.connectorId !== CONNECTOR_ID;
      if (
        wrongConnector ||
        this.#faulted ||
        this.#transaction !== undefined ||
        this.#startTimer !== undefined
      ) {
        this.#log(`RemoteStartTransaction rejected (${this.#status})`);
        return { status: "Rejected" };
      }
      this.#afterReply.set(messageId, () => {
        this.#authorizedIdTag = request.idTag;
        this.#scheduleStart();
        this.#updateStatus();
      });
      return { status: "Accepted" };
    });

    peer.handle("RemoteStopTransaction", (request, { messageId }) => {
      if (this.#transaction?.id !== request.transactionId) {
        return { status: "Rejected" };
      }
      this.#afterReply.set(messageId, () => {
        this.#stopTransaction("Remote");
        this.#updateStatus();
      });
      return { status: "Accepted" };
    });

    peer.handle("ChangeConfiguration", (request, { messageId }) => {
      const { status, key } = this.config.change(request.key, request.value);
      this.#log(`ChangeConfiguration ${request.key}=${request.value}: ${status}`);
      if (key !== undefined) {
        this.#afterReply.set(messageId, () => {
          this.#applyConfig(key);
        });
      }
      return { status };
    });

    peer.handle("GetConfiguration", (request) => this.config.read(request.key));

    peer.handle("TriggerMessage", (request, { messageId }) => {
      if (
        request.connectorId !== undefined &&
        request.connectorId !== 0 &&
        request.connectorId !== CONNECTOR_ID
      ) {
        return { status: "Rejected" };
      }
      let action: (() => void) | undefined;
      switch (request.requestedMessage) {
        case "BootNotification":
          action = () => {
            this.#boot().catch((error: unknown) => {
              this.#problem(toError(error));
            });
          };
          break;
        case "Heartbeat":
          action = () => {
            this.#post("Heartbeat", {});
          };
          break;
        case "StatusNotification":
          action = () => {
            this.#sendStatus();
          };
          break;
        case "MeterValues":
          action = () => {
            this.#sendMeterValues("Trigger").catch(() => undefined);
          };
          break;
        case "DiagnosticsStatusNotification":
        case "FirmwareStatusNotification":
          return { status: "NotImplemented" };
      }
      this.#afterReply.set(messageId, action);
      return { status: "Accepted" };
    });

    peer.handle("Reset", (request, { messageId }) => {
      this.#afterReply.set(messageId, () => {
        void this.#reboot(request.type === "Hard" ? "HardReset" : "SoftReset");
      });
      return { status: "Accepted" };
    });

    peer.handle("UnlockConnector", (request, { messageId }) => {
      if (this.#options.tethered === true) {
        return { status: "NotSupported" };
      }
      if (request.connectorId !== CONNECTOR_ID) {
        return { status: "UnlockFailed" };
      }
      this.#afterReply.set(messageId, () => {
        this.#stopTransaction("UnlockCommand");
        this.#updateStatus();
      });
      return { status: "Unlocked" };
    });
  }

  #applyConfig(key: ZappiConfigKey): void {
    switch (key) {
      case "HeartbeatInterval":
        this.#scheduleHeartbeat();
        break;
      case "MeterValueSampleInterval":
        if (this.#transaction !== undefined) {
          this.#scheduleMeterValues();
        }
        break;
      case "FreeCharging":
        if (this.config.get("FreeCharging") && this.#plugged && this.#transaction === undefined) {
          this.#authorizedIdTag ??= this.#options.freeChargingIdTag ?? "FreeCharging";
          this.#scheduleStart();
        }
        this.#updateStatus();
        break;
      case "OCPPChargeMode":
        this.#updateStatus();
        break;
      case "LocalAuthListEnabled":
      case "StopTransactionOnInvalidId":
        break;
    }
  }

  async #reboot(reason: "HardReset" | "SoftReset"): Promise<void> {
    this.#log(`rebooting (${reason})`);
    this.#cancelStart();
    this.#stopTransaction(reason);
    this.#authorizedIdTag = undefined;
    this.#evDrawing = true;
    this.#updateStatus();
    await this.#chain;
    const ws = this.#ws;
    if (ws !== undefined) {
      const closed = this.waitForDisconnect();
      this.#intentionalClose = true;
      ws.terminate();
      await closed;
    }
    this.#reconnectTimer = setTimeout(() => {
      this.connect().catch((error: unknown) => {
        this.#problem(toError(error));
      });
    }, this.#options.resetDelayMs ?? 1000);
  }

  // ---------------------------------------------------------------------------
  // Transactions and metering

  #scheduleStart(): void {
    const idTag = this.#authorizedIdTag;
    if (
      idTag === undefined ||
      !this.#plugged ||
      this.#faulted ||
      this.#transaction !== undefined ||
      this.#startTimer !== undefined
    ) {
      return;
    }
    this.#startTimer = setTimeout(() => {
      this.#startTimer = undefined;
      this.#startTransaction(idTag);
    }, this.#options.startDelayMs ?? 1000);
  }

  #cancelStart(): void {
    clearTimeout(this.#startTimer);
    this.#startTimer = undefined;
  }

  #startTransaction(idTag: string): void {
    if (!this.#plugged || this.#faulted || this.#transaction !== undefined) {
      return;
    }
    this.#accrue();
    const transaction: MutableTransaction = {
      id: undefined,
      idTag,
      meterStart: Math.round(this.#meterWh),
      startedAt: new Date().toISOString(),
      suspendedByEvse: false,
    };
    this.#transaction = transaction;
    this.#finishing = false;
    this.#log(`transaction starting for ${idTag} at ${String(transaction.meterStart)} Wh`);
    if (!this.faults.neverSendStartTransaction) {
      this.#post(
        "StartTransaction",
        {
          connectorId: CONNECTOR_ID,
          idTag,
          meterStart: transaction.meterStart,
          timestamp: transaction.startedAt,
        },
        {
          persistent: true,
          onResponse: (response) => {
            transaction.id = response.transactionId;
            this.#log(
              `transaction ${String(response.transactionId)}: ${response.idTagInfo.status}`,
            );
            this.emit("transactionStarted", snapshot(transaction));
            if (response.idTagInfo.status !== "Accepted" && this.#transaction === transaction) {
              this.#rejectTransactionTag(transaction);
            }
          },
        },
      );
    }
    this.#updateStatus();
    this.#scheduleMeterValues();
  }

  #rejectTransactionTag(transaction: MutableTransaction): void {
    if (this.config.get("StopTransactionOnInvalidId")) {
      this.#stopTransaction("DeAuthorized");
      this.#authorizedIdTag = undefined;
    } else {
      transaction.suspendedByEvse = true;
    }
    this.#updateStatus();
  }

  #stopTransaction(reason: StopReason): void {
    const transaction = this.#transaction;
    if (transaction === undefined) {
      return;
    }
    this.#accrue();
    const meterStop = Math.round(this.#meterWh);
    const timestamp = new Date().toISOString();
    this.#transaction = undefined;
    this.#finishing = this.#plugged;
    clearTimeout(this.#meterTimer);
    this.#meterTimer = undefined;
    this.#log(`transaction stopping (${reason}) at ${String(meterStop)} Wh`);
    if (!this.faults.neverSendStopTransaction) {
      this.#post(
        "StopTransaction",
        () =>
          transaction.id === undefined
            ? undefined
            : {
                idTag: transaction.idTag,
                meterStop,
                timestamp,
                transactionId: transaction.id,
                reason,
              },
        { persistent: true },
      );
    }
    this.emit("transactionStopped", { transaction: snapshot(transaction), meterStop, reason });
  }

  #powerW(status: ChargePointStatus = this.#status): number {
    return status === "Charging" ? Math.round((this.#options.chargeRateKw ?? 7.2) * 1000) : 0;
  }

  /** Adds the energy delivered since the last update at the power of the current status. */
  #accrue(): void {
    const now = Date.now();
    this.#meterWh += (this.#powerW() * (now - this.#meterUpdatedAt)) / 3_600_000;
    this.#meterUpdatedAt = now;
  }

  #scheduleMeterValues(): void {
    clearTimeout(this.#meterTimer);
    this.#meterTimer = undefined;
    const seconds = this.config.get("MeterValueSampleInterval");
    if (seconds <= 0 || this.#transaction === undefined) {
      return;
    }
    this.#meterTimer = setTimeout(() => {
      this.#meterTimer = undefined;
      this.#sendMeterValues("Sample.Periodic").catch(() => undefined);
      this.#scheduleMeterValues();
    }, seconds * 1000);
  }

  #sendMeterValues(context: ReadingContext): Promise<OcppResponse<"MeterValues">> {
    this.#accrue();
    const timestamp = new Date().toISOString();
    const energy = String(Math.round(this.#meterWh));
    const power = String(this.#powerW());
    const transaction = this.#transaction;
    const promise = this.#send(
      "MeterValues",
      () => ({
        connectorId: CONNECTOR_ID,
        ...(transaction?.id === undefined ? {} : { transactionId: transaction.id }),
        meterValue: [
          {
            timestamp,
            sampledValue: [
              {
                value: energy,
                context,
                measurand: "Energy.Active.Import.Register",
                location: "Outlet",
                unit: "Wh",
              },
              {
                value: power,
                context,
                measurand: "Power.Active.Import",
                location: "Outlet",
                unit: "W",
              },
            ],
          },
        ],
      }),
      { persistent: transaction !== undefined },
    );
    promise.catch((error: unknown) => {
      if (!(error instanceof SimStoppedError) && !(error instanceof SimDisconnectedError)) {
        this.#problem(toError(error));
      }
    });
    return promise;
  }

  // ---------------------------------------------------------------------------
  // Status

  #chargeMode(): OcppChargeMode {
    const locked =
      !this.config.get("FreeCharging") &&
      this.#authorizedIdTag === undefined &&
      this.#transaction === undefined;
    return locked ? "Stop" : this.config.get("OCPPChargeMode");
  }

  #deriveStatus(): ChargePointStatus {
    if (this.#faulted) {
      return "Faulted";
    }
    const transaction = this.#transaction;
    if (transaction !== undefined) {
      if (transaction.suspendedByEvse || this.config.get("OCPPChargeMode") === "Stop") {
        return "SuspendedEVSE";
      }
      return this.#evDrawing ? "Charging" : "SuspendedEV";
    }
    if (this.#plugged) {
      return this.#finishing ? "Finishing" : "Preparing";
    }
    return "Available";
  }

  #updateStatus(): void {
    const status = this.#deriveStatus();
    if (status === this.#status) {
      return;
    }
    this.#accrue();
    this.#status = status;
    this.#log(`status ${status}${this.#errorCode === "NoError" ? "" : ` (${this.#errorCode})`}`);
    this.emit("status", { status, errorCode: this.#errorCode });
    if (this.#online) {
      this.#sendStatus();
    }
  }

  #sendStatus(): void {
    this.#post("StatusNotification", {
      connectorId: CONNECTOR_ID,
      errorCode: this.#errorCode,
      status: this.#status,
      timestamp: new Date().toISOString(),
      ...(this.#faultInfo === undefined ? {} : { info: this.#faultInfo.slice(0, 50) }),
    });
  }

  #scheduleHeartbeat(): void {
    clearTimeout(this.#heartbeatTimer);
    this.#heartbeatTimer = undefined;
    const seconds = this.config.get("HeartbeatInterval");
    if (seconds <= 0 || !this.#online) {
      return;
    }
    this.#heartbeatTimer = setTimeout(() => {
      this.#post("Heartbeat", {});
      this.#scheduleHeartbeat();
    }, seconds * 1000);
  }

  // ---------------------------------------------------------------------------
  // Helpers

  #calls(direction: SimFrame["direction"], action: string): JsonObject[] {
    return this.frames.flatMap((entry) =>
      entry.direction === direction &&
      entry.frame.type === MessageTypeId.Call &&
      entry.frame.action === action
        ? [entry.frame.payload]
        : [],
    );
  }

  #waitForEvent<E extends "frame" | "status" | "disconnected", T>(
    event: E,
    description: string,
    timeoutMs: number | undefined,
    match: (...args: ZappiSimEvents[E]) => T | undefined,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const listener = (...args: ZappiSimEvents[E]) => {
        const result = match(...args);
        if (result !== undefined) {
          clearTimeout(timer);
          this.off(event, listener as never);
          resolve(result);
        }
      };
      const timer = setTimeout(() => {
        this.off(event, listener as never);
        reject(new Error(`Timed out waiting for ${description}`));
      }, timeoutMs ?? 5_000);
      this.on(event, listener as never);
    });
  }

  #problem(error: Error): void {
    this.#log(`problem: ${error.message}`);
    this.emit("problem", error);
  }

  #log(line: string): void {
    this.#options.log?.(`[${this.chargeboxId}] ${line}`);
  }
}
