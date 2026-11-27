import type { ControlResult } from "@nd/domain";
import {
  callError,
  type CentralSystemAction,
  type CentralSystemPeer,
  type ChargePointAction,
  createCentralSystemPeer,
  type Frame,
  type InboundHandlers,
  MessageTypeId,
  OcppError,
  type OcppRequest,
  type OcppResponse,
  OcppTimeoutError,
  parseFrame,
  serializeFrame,
} from "@nd/ocpp-core";
import { WebSocket } from "ws";

import type { Logger } from "./logger.ts";
import type { ChargerRef, GatewayStore, OcppMessageRecord } from "./store.ts";

const MESSAGE_TYPES = {
  [MessageTypeId.Call]: "call",
  [MessageTypeId.CallResult]: "call_result",
  [MessageTypeId.CallError]: "call_error",
} as const;

/** Longest raw text kept for a frame that could not be parsed. */
const MAX_INVALID_FRAME_CHARS = 4_096;

function record(chargerId: string, direction: "in" | "out", frame: Frame): OcppMessageRecord {
  const base = {
    chargerId,
    direction,
    messageType: MESSAGE_TYPES[frame.type],
    messageId: frame.messageId,
  };
  switch (frame.type) {
    case MessageTypeId.Call:
      return { ...base, action: frame.action, payload: frame.payload };
    case MessageTypeId.CallResult:
      return { ...base, action: null, payload: frame.payload };
    case MessageTypeId.CallError:
      return {
        ...base,
        action: null,
        payload: {
          errorCode: frame.errorCode,
          errorDescription: frame.errorDescription,
          errorDetails: frame.errorDetails,
        },
      };
  }
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface ChargerConnectionOptions {
  readonly charger: ChargerRef;
  readonly ws: WebSocket;
  readonly store: GatewayStore;
  readonly logger: Logger;
  /** Reply timeout for outbound calls, in ms (OCPP's 30 s by default). */
  readonly callTimeoutMs?: number;
}

/**
 * One charger's socket: OCPP RPC over the WebSocket, with every frame in and
 * out written to `ocpp_messages`. An inbound CALL is stored before its handler
 * runs, so it is never acknowledged unstored; if it cannot be stored the
 * charger gets an InternalError CALLERROR and will retry. Inbound CALLs are
 * handled one at a time, in order.
 */
export class ChargerConnection {
  readonly charger: ChargerRef;
  readonly connectedAt = new Date();
  readonly #ws: WebSocket;
  readonly #store: GatewayStore;
  readonly #logger: Logger;
  readonly #peer: CentralSystemPeer;
  readonly #afterReply = new Map<string, () => void>();
  #inbound: Promise<void> = Promise.resolve();
  readonly #replies = new Set<Promise<void>>();
  #alive = true;

  constructor(options: ChargerConnectionOptions) {
    this.charger = options.charger;
    this.#ws = options.ws;
    this.#store = options.store;
    this.#logger = options.logger;
    this.#peer = createCentralSystemPeer({
      send: (text, frame) => this.#transmit(text, frame),
      ...(options.callTimeoutMs === undefined ? {} : { timeoutMs: options.callTimeoutMs }),
      onProtocolError: (error) => {
        this.#logger.warn({ err: errorMessage(error) }, "OCPP protocol error");
      },
    });
    this.#ws.on("pong", () => {
      this.#alive = true;
    });
  }

  /** Registers the handlers for charger-initiated actions. */
  handle(handlers: InboundHandlers<ChargePointAction>): void {
    for (const [action, handler] of Object.entries(handlers)) {
      this.#peer.handle(action as ChargePointAction, handler as never);
    }
  }

  get open(): boolean {
    return this.#ws.readyState === WebSocket.OPEN;
  }

  /** Runs `run` once the reply to inbound CALL `messageId` has been sent. */
  afterReply(messageId: string, run: () => void): void {
    this.#afterReply.set(messageId, run);
  }

  /** Processes one received text message. Resolves once it is handled. */
  receive(text: string): Promise<void> {
    const parsed = parseFrame(text);
    if (parsed.ok && parsed.frame.type !== MessageTypeId.Call) {
      // A reply to one of our calls: store it, then settle the pending call.
      // Never queued behind inbound CALLs, which may be waiting on a reply.
      const settled = this.#storeQuietly(record(this.charger.id, "in", parsed.frame)).then(() =>
        this.#peer.handleMessage(text),
      );
      this.#replies.add(settled);
      void settled.finally(() => this.#replies.delete(settled));
      return settled;
    }
    const next = this.#inbound.then(async () => {
      if (!parsed.ok) {
        const { messageId, messageTypeId } = parsed.error;
        if (messageId !== undefined && messageTypeId !== undefined) {
          await this.#storeQuietly({
            chargerId: this.charger.id,
            direction: "in",
            messageType: MESSAGE_TYPES[messageTypeId],
            messageId,
            action: null,
            payload: { invalidFrame: text.slice(0, MAX_INVALID_FRAME_CHARS) },
          });
        }
        await this.#peer.handleMessage(text);
        return;
      }
      const { frame } = parsed;
      if (frame.type !== MessageTypeId.Call) {
        return;
      }
      try {
        await this.#store.recordMessage(record(this.charger.id, "in", frame));
      } catch (error) {
        this.#logger.error(
          { err: errorMessage(error), action: frame.action, messageId: frame.messageId },
          "could not store an inbound CALL; answering InternalError",
        );
        const reply = callError(frame.messageId, "InternalError", "Message could not be stored");
        await this.#transmit(serializeFrame(reply), reply).catch(() => undefined);
        return;
      }
      await this.#peer.handleMessage(text);
    });
    this.#inbound = next.catch((error: unknown) => {
      this.#logger.error({ err: errorMessage(error) }, "inbound message failed");
    });
    return this.#inbound;
  }

  /**
   * Sends a CALL and waits for the charger's answer. Never throws: a missing
   * or failed answer comes back as the reason there is none.
   */
  async call<A extends CentralSystemAction>(
    action: A,
    request: OcppRequest<A>,
    options: { timeoutMs?: number } = {},
  ): Promise<ControlResult<OcppResponse<A>>> {
    if (!this.open) {
      return { ok: false, reason: "offline", message: "The charger is not connected" };
    }
    try {
      const response = await this.#peer.call(action, request, options);
      return { ok: true, response };
    } catch (error) {
      const message = errorMessage(error);
      if (error instanceof OcppTimeoutError) {
        this.#logger.warn({ action, messageId: error.messageId }, "no response from the charger");
        return { ok: false, reason: "no_response", message };
      }
      if (error instanceof OcppError) {
        this.#logger.warn({ action, code: error.code }, "charger answered with an error");
        return { ok: false, reason: "call_error", message, errorCode: error.code };
      }
      this.#logger.warn({ action, err: message }, "call could not be sent");
      return { ok: false, reason: "send_failed", message };
    }
  }

  /**
   * One keep-alive round: terminates the socket if the previous ping got no
   * pong, otherwise pings again. Returns false once terminated.
   */
  heartbeatTick(): boolean {
    if (!this.#alive) {
      this.#logger.warn("no pong from the charger; terminating the socket");
      this.#ws.terminate();
      return false;
    }
    this.#alive = false;
    if (this.open) {
      this.#ws.ping();
    }
    return true;
  }

  /** Rejects outbound calls still waiting, after the socket closed. */
  async closed(): Promise<void> {
    this.#afterReply.clear();
    // A reply that arrived just before the close is still being stored; let it settle its call.
    await Promise.allSettled([...this.#replies]);
    this.#peer.cancelAll(new Error("The charger disconnected"));
  }

  close(code: number, reason: string): void {
    if (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING) {
      this.#ws.close(code, reason);
    }
  }

  terminate(): void {
    this.#ws.terminate();
  }

  async #storeQuietly(message: OcppMessageRecord): Promise<void> {
    try {
      await this.#store.recordMessage(message);
    } catch (error) {
      this.#logger.error(
        { err: errorMessage(error), messageId: message.messageId, direction: message.direction },
        "could not store an OCPP message",
      );
    }
  }

  async #transmit(text: string, frame: Frame): Promise<void> {
    if (frame.type === MessageTypeId.Call) {
      // An outbound CALL is stored first; if that fails it is not sent.
      await this.#store.recordMessage(record(this.charger.id, "out", frame));
    } else {
      await this.#storeQuietly(record(this.charger.id, "out", frame));
    }
    if (!this.open) {
      throw new Error("The charger socket is closed");
    }
    this.#ws.send(text);
    if (frame.type !== MessageTypeId.Call) {
      const after = this.#afterReply.get(frame.messageId);
      this.#afterReply.delete(frame.messageId);
      after?.();
    }
  }
}
