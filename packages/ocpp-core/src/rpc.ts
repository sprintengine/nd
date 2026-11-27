import {
  type ActionSchemas,
  type CentralSystemAction,
  centralSystemActions,
  type ChargePointAction,
  chargePointActions,
  type OcppAction,
  type OcppRequest,
  type OcppResponse,
} from "./actions.ts";
import { OcppError, ocppErrorFromZod, OcppTimeoutError } from "./errors.ts";
import {
  type Call,
  call as callFrame,
  type CallError,
  callError,
  type CallResult,
  callResult,
  createMessageId,
  type Frame,
  type FrameParseError,
  type JsonObject,
  MessageTypeId,
  parseFrame,
  serializeFrame,
} from "./framing.ts";

/** OCPP's recommended reply timeout for an outbound CALL. */
export const DEFAULT_CALL_TIMEOUT_MS = 30_000;

interface Pending {
  readonly action: string;
  readonly resolve: (payload: JsonObject) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * Outbound calls waiting for their CALLRESULT or CALLERROR, keyed by message
 * id. Each call is rejected with an {@link OcppTimeoutError} when no reply
 * arrives in time. Timers use the global `setTimeout`, so fake timers work.
 */
export class PendingCalls {
  readonly timeoutMs: number;
  readonly #pending = new Map<string, Pending>();

  constructor(options: { timeoutMs?: number } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  }

  get size(): number {
    return this.#pending.size;
  }

  has(messageId: string): boolean {
    return this.#pending.has(messageId);
  }

  /** Waits for the reply to `messageId`; resolves with a CALLRESULT payload. */
  register(
    messageId: string,
    action: string,
    timeoutMs: number = this.timeoutMs,
  ): Promise<JsonObject> {
    if (this.#pending.has(messageId)) {
      return Promise.reject(new Error(`A call with message id ${messageId} is already pending`));
    }
    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(messageId);
        reject(new OcppTimeoutError(action, messageId, timeoutMs));
      }, timeoutMs);
      this.#pending.set(messageId, { action, resolve, reject, timer });
    });
  }

  /**
   * Settles the call a CALLRESULT or CALLERROR answers. Returns false when no
   * call with that message id is pending (for example, it already timed out).
   */
  settle(frame: CallResult | CallError): boolean {
    const pending = this.#take(frame.messageId);
    if (pending === undefined) {
      return false;
    }
    if (frame.type === MessageTypeId.CallResult) {
      pending.resolve(frame.payload);
    } else {
      pending.reject(
        new OcppError(frame.errorCode, frame.errorDescription, {
          details: frame.errorDetails,
          remote: true,
        }),
      );
    }
    return true;
  }

  /** Rejects one pending call. Returns false when it is not pending. */
  cancel(messageId: string, error: Error): boolean {
    const pending = this.#take(messageId);
    pending?.reject(error);
    return pending !== undefined;
  }

  /** Rejects every pending call, for example when the connection closes. */
  cancelAll(error: Error): void {
    for (const messageId of [...this.#pending.keys()]) {
      this.cancel(messageId, error);
    }
  }

  #take(messageId: string): Pending | undefined {
    const pending = this.#pending.get(messageId);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      this.#pending.delete(messageId);
    }
    return pending;
  }
}

export interface CallContext<A extends OcppAction = OcppAction> {
  readonly action: A;
  readonly messageId: string;
}

/**
 * Answers one inbound CALL. Return the response payload, or throw an
 * {@link OcppError} to answer with that CALLERROR. Any other error becomes an
 * InternalError.
 */
export type InboundHandler<A extends OcppAction> = (
  request: OcppRequest<A>,
  context: CallContext<A>,
) => OcppResponse<A> | Promise<OcppResponse<A>>;

export type InboundHandlers<In extends OcppAction> = { readonly [A in In]?: InboundHandler<A> };

type AnyHandler = (request: unknown, context: CallContext) => unknown;

export interface OcppPeerOptions<In extends OcppAction> {
  /** Sends one serialised frame to the other side. May throw if the transport is closed. */
  readonly send: (text: string, frame: Frame) => void | Promise<void>;
  readonly handlers?: InboundHandlers<In>;
  /** Reply timeout for outbound calls, in ms. Defaults to 30 s. */
  readonly timeoutMs?: number;
  /**
   * Told about messages that cannot be answered or matched: unparseable
   * frames, replies to unknown message ids, and failures to send a reply.
   */
  readonly onProtocolError?: (error: Error | FrameParseError, raw: string) => void;
}

/**
 * One side of an OCPP-J connection, independent of the transport: feed it
 * every received text message with {@link OcppPeer.handleMessage}, and it
 * sends frames through `options.send`.
 *
 * - Outbound: {@link OcppPeer.call} validates the request, sends a CALL with
 *   a fresh UUID message id, and resolves with the validated response.
 * - Inbound: each CALL is validated against its schema and dispatched to the
 *   registered handler. Unknown actions get NotImplemented, known actions
 *   without a handler NotSupported, and schema failures the matching
 *   FormationViolation, OccurenceConstraintViolation, TypeConstraintViolation
 *   or PropertyConstraintViolation.
 *
 * Use {@link createCentralSystemPeer} or {@link createChargePointPeer}.
 */
export class OcppPeer<Out extends OcppAction, In extends OcppAction> {
  readonly #outbound: Readonly<Record<Out, ActionSchemas>>;
  readonly #inbound: Readonly<Record<In, ActionSchemas>>;
  readonly #send: OcppPeerOptions<In>["send"];
  readonly #onProtocolError: NonNullable<OcppPeerOptions<In>["onProtocolError"]>;
  readonly #handlers = new Map<string, AnyHandler>();
  readonly #pending: PendingCalls;

  constructor(
    outbound: Readonly<Record<Out, ActionSchemas>>,
    inbound: Readonly<Record<In, ActionSchemas>>,
    options: OcppPeerOptions<In>,
  ) {
    this.#outbound = outbound;
    this.#inbound = inbound;
    this.#send = options.send;
    this.#onProtocolError = options.onProtocolError ?? (() => undefined);
    this.#pending = new PendingCalls(
      options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    );
    for (const [action, handler] of Object.entries(options.handlers ?? {})) {
      this.#handlers.set(action, handler as AnyHandler);
    }
  }

  /** Number of outbound calls still waiting for a reply. */
  get pendingCount(): number {
    return this.#pending.size;
  }

  /** Registers (or replaces) the handler for an inbound action. */
  handle<A extends In>(action: A, handler: InboundHandler<A>): this {
    this.#handlers.set(action, handler as AnyHandler);
    return this;
  }

  /** Sends a CALL and waits for its validated response. */
  async call<A extends Out>(
    action: A,
    request: OcppRequest<A>,
    options: { timeoutMs?: number; messageId?: string } = {},
  ): Promise<OcppResponse<A>> {
    const schemas = this.#outbound[action];
    const parsedRequest = schemas.request.safeParse(request);
    if (!parsedRequest.success) {
      throw ocppErrorFromZod(parsedRequest.error, request);
    }
    const frame = callFrame(
      action,
      parsedRequest.data as JsonObject,
      options.messageId ?? createMessageId(),
    );
    const reply = this.#pending.register(
      frame.messageId,
      action,
      options.timeoutMs ?? this.#pending.timeoutMs,
    );
    // Awaited below; this only stops a timeout during a slow send counting as unhandled.
    reply.catch(() => undefined);
    try {
      await this.#send(serializeFrame(frame), frame);
    } catch (error) {
      this.#pending.cancel(
        frame.messageId,
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    const payload = await reply;
    const parsedResponse = schemas.response.safeParse(payload);
    if (!parsedResponse.success) {
      throw ocppErrorFromZod(parsedResponse.error, payload);
    }
    return parsedResponse.data as OcppResponse<A>;
  }

  /** Rejects every outbound call still waiting, for example when the transport closes. */
  cancelAll(error: Error): void {
    this.#pending.cancelAll(error);
  }

  /** Processes one received text message. Resolves once any reply has been sent. */
  async handleMessage(text: string): Promise<void> {
    const parsed = parseFrame(text);
    if (!parsed.ok) {
      const { error } = parsed;
      if (error.messageTypeId === MessageTypeId.Call && error.messageId !== undefined) {
        await this.#reply(callError(error.messageId, error.code, error.description), text);
      } else {
        this.#onProtocolError(error, text);
      }
      return;
    }
    const { frame } = parsed;
    if (frame.type === MessageTypeId.Call) {
      await this.#reply(await this.#dispatch(frame), text);
    } else if (!this.#pending.settle(frame)) {
      this.#onProtocolError(
        new Error(`Reply to unknown or expired message id ${frame.messageId}`),
        text,
      );
    }
  }

  async #dispatch(frame: Call): Promise<CallResult | CallError> {
    const { action, messageId, payload } = frame;
    if (!Object.hasOwn(this.#inbound, action)) {
      return callError(messageId, "NotImplemented", `Unknown action ${action}`);
    }
    const handler = this.#handlers.get(action);
    if (handler === undefined) {
      return callError(messageId, "NotSupported", `Action ${action} is not supported`);
    }
    const schemas = this.#inbound[action as In];
    const request = schemas.request.safeParse(payload);
    if (!request.success) {
      const error = ocppErrorFromZod(request.error, payload);
      return callError(messageId, error.code, error.message, error.details);
    }
    let result: unknown;
    try {
      result = await handler(request.data, { action: action as OcppAction, messageId });
    } catch (error) {
      if (error instanceof OcppError) {
        return callError(messageId, error.code, error.message, error.details);
      }
      return callError(
        messageId,
        "InternalError",
        error instanceof Error ? error.message : String(error),
      );
    }
    const response = schemas.response.safeParse(result);
    if (!response.success) {
      return callError(
        messageId,
        "InternalError",
        `Handler for ${action} returned an invalid response`,
      );
    }
    return callResult(messageId, response.data as JsonObject);
  }

  async #reply(frame: CallResult | CallError, raw: string): Promise<void> {
    try {
      await this.#send(serializeFrame(frame), frame);
    } catch (error) {
      this.#onProtocolError(error instanceof Error ? error : new Error(String(error)), raw);
    }
  }
}

export type CentralSystemPeer = OcppPeer<CentralSystemAction, ChargePointAction>;
export type ChargePointPeer = OcppPeer<ChargePointAction, CentralSystemAction>;

/** The central system's side: calls charger actions, answers charger-initiated ones. */
export function createCentralSystemPeer(
  options: OcppPeerOptions<ChargePointAction>,
): CentralSystemPeer {
  return new OcppPeer(centralSystemActions, chargePointActions, options);
}

/** A charge point's side: calls charger-initiated actions, answers central-system ones. */
export function createChargePointPeer(
  options: OcppPeerOptions<CentralSystemAction>,
): ChargePointPeer {
  return new OcppPeer(chargePointActions, centralSystemActions, options);
}
