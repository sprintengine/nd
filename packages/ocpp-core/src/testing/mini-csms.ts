import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { type WebSocket, WebSocketServer } from "ws";

import type {
  CentralSystemAction,
  ChargePointAction,
  OcppRequest,
  OcppResponse,
} from "../actions.ts";
import { selectSubprotocol } from "../index.ts";
import { type CentralSystemPeer, createCentralSystemPeer, type InboundHandlers } from "../rpc.ts";
import type { AuthorizationStatus } from "../schemas/common.ts";
import { rawDataToString } from "../sim/zappi.ts";

/** A charger connected to the {@link MiniCsms}. */
export interface MiniCsmsConnection {
  readonly chargeboxId: string;
  readonly protocol: string;
  readonly peer: CentralSystemPeer;
  /** Sends raw text, bypassing the peer. */
  send(text: string): void;
  close(): void;
}

export interface ReceivedCall {
  readonly chargeboxId: string;
  readonly action: ChargePointAction;
  readonly payload: unknown;
}

export interface MiniCsmsOptions {
  /** Chargebox id to Basic Auth secret. Unknown ids get 404 and wrong secrets 401. Omit to skip auth. */
  readonly secrets?: Readonly<Record<string, string>>;
  readonly heartbeatInterval?: number;
  readonly bootStatus?: "Accepted" | "Pending" | "Rejected";
  /** Offer no subprotocol on the upgrade, to test the client refusing it. */
  readonly withoutSubprotocol?: boolean;
  /** Overrides for the default handlers. */
  readonly handlers?: InboundHandlers<ChargePointAction>;
}

/**
 * A tiny OCPP 1.6J central system for tests: accepts chargers on
 * `/v16/<chargeboxId>`, answers every charger-initiated action, records
 * what it received, and lets the test make calls to a charger.
 */
export class MiniCsms {
  readonly connections = new Map<string, MiniCsmsConnection>();
  readonly received: ReceivedCall[] = [];
  /** idTags that Authorize and StartTransaction answer Invalid for. */
  readonly invalidIdTags = new Set<string>();
  readonly upgrades: { url: string; authorization: string | undefined; protocols: string }[] = [];
  nextTransactionId = 1;
  /** Chargebox id to secret; change it to make later upgrades fail. Undefined skips auth. */
  secrets: Record<string, string> | undefined;
  bootStatus: "Accepted" | "Pending" | "Rejected";

  readonly #server: WebSocketServer;
  readonly #options: MiniCsmsOptions;
  readonly #connectionWaiters: { id: string; resolve: (connection: MiniCsmsConnection) => void }[] =
    [];
  readonly #callWaiters: {
    match: (call: ReceivedCall) => boolean;
    resolve: (call: ReceivedCall) => void;
  }[] = [];

  private constructor(server: WebSocketServer, options: MiniCsmsOptions) {
    this.#server = server;
    this.#options = options;
    this.bootStatus = options.bootStatus ?? "Accepted";
    this.secrets = options.secrets === undefined ? undefined : { ...options.secrets };
    server.on("connection", (ws, request) => {
      this.#accept(ws, request);
    });
  }

  static async start(options: MiniCsmsOptions = {}): Promise<MiniCsms> {
    // verifyClient runs per upgrade, after construction, and reads the current secrets.
    const ref: { csms?: MiniCsms } = {};
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      handleProtocols: (protocols) =>
        options.withoutSubprotocol === true ? false : (selectSubprotocol(protocols) ?? false),
      verifyClient: (info, callback) => {
        const status = MiniCsms.#authorize(ref.csms?.secrets, info.req);
        if (status === 200) {
          callback(true);
        } else {
          callback(false, status);
        }
      },
    });
    await new Promise<void>((resolve) => {
      server.once("listening", resolve);
    });
    ref.csms = new MiniCsms(server, options);
    return ref.csms;
  }

  static #authorize(secrets: Record<string, string> | undefined, request: IncomingMessage): number {
    const id = MiniCsms.#chargeboxId(request);
    if (id === undefined) {
      return 404;
    }
    if (secrets === undefined) {
      return 200;
    }
    const expected = secrets[id];
    if (expected === undefined) {
      return 404;
    }
    const header = request.headers.authorization ?? "";
    const given = header.startsWith("Basic ")
      ? Buffer.from(header.slice(6), "base64").toString("utf8")
      : "";
    return given === `${id}:${expected}` ? 200 : 401;
  }

  static #chargeboxId(request: IncomingMessage): string | undefined {
    const match = /^\/v16\/([^/?]+)$/.exec(request.url ?? "");
    return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
  }

  get url(): string {
    const { port } = this.#server.address() as AddressInfo;
    return `ws://127.0.0.1:${String(port)}/v16/`;
  }

  connection(chargeboxId: string): MiniCsmsConnection {
    const connection = this.connections.get(chargeboxId);
    if (connection === undefined) {
      throw new Error(`${chargeboxId} is not connected`);
    }
    return connection;
  }

  waitForConnection(chargeboxId: string): Promise<MiniCsmsConnection> {
    const existing = this.connections.get(chargeboxId);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve) => {
      this.#connectionWaiters.push({ id: chargeboxId, resolve });
    });
  }

  /** Resolves with the first received call for `action` from index `since` on that matches. */
  waitForCall<A extends ChargePointAction>(
    action: A,
    options: { since?: number; predicate?: (payload: OcppRequest<A>) => boolean } = {},
  ): Promise<OcppRequest<A>> {
    const match = (call: ReceivedCall) =>
      call.action === action && (options.predicate?.(call.payload as OcppRequest<A>) ?? true);
    const found = this.received.slice(options.since ?? 0).find(match);
    if (found !== undefined) {
      return Promise.resolve(found.payload as OcppRequest<A>);
    }
    return new Promise((resolve) => {
      this.#callWaiters.push({
        match,
        resolve: (call) => {
          resolve(call.payload as OcppRequest<A>);
        },
      });
    });
  }

  callsOf<A extends ChargePointAction>(action: A): OcppRequest<A>[] {
    return this.received
      .filter((call) => call.action === action)
      .map((call) => call.payload as OcppRequest<A>);
  }

  async close(): Promise<void> {
    for (const client of this.#server.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }

  #accept(ws: WebSocket, request: IncomingMessage): void {
    const chargeboxId = MiniCsms.#chargeboxId(request) ?? "";
    this.upgrades.push({
      url: request.url ?? "",
      authorization: request.headers.authorization,
      protocols: request.headers["sec-websocket-protocol"] ?? "",
    });
    const status = (idTag: string): AuthorizationStatus =>
      this.invalidIdTags.has(idTag) ? "Invalid" : "Accepted";
    const now = () => new Date().toISOString();
    const record = <A extends ChargePointAction>(action: A, payload: OcppRequest<A>) => {
      const call: ReceivedCall = { chargeboxId, action, payload };
      this.received.push(call);
      for (const waiter of this.#callWaiters.filter((candidate) => candidate.match(call))) {
        this.#callWaiters.splice(this.#callWaiters.indexOf(waiter), 1);
        waiter.resolve(call);
      }
    };
    const handlers: Required<InboundHandlers<ChargePointAction>> = {
      Authorize: ({ idTag }) => ({ idTagInfo: { status: status(idTag) } }),
      BootNotification: () => ({
        status: this.bootStatus,
        currentTime: now(),
        interval: this.#options.heartbeatInterval ?? 300,
      }),
      DataTransfer: () => ({ status: "UnknownVendorId" }),
      Heartbeat: () => ({ currentTime: now() }),
      MeterValues: () => ({}),
      StartTransaction: ({ idTag }) => ({
        idTagInfo: { status: status(idTag) },
        transactionId: this.nextTransactionId++,
      }),
      StatusNotification: () => ({}),
      StopTransaction: () => ({}),
      ...this.#options.handlers,
    };
    const peer = createCentralSystemPeer({
      send: (text) => {
        ws.send(text);
      },
    });
    for (const action of Object.keys(handlers) as ChargePointAction[]) {
      const handler = handlers[action] as (request: never, context: never) => unknown;
      peer.handle(action, ((request: never, context: never) => {
        record(action, request);
        return handler(request, context);
      }) as never);
    }
    const connection: MiniCsmsConnection = {
      chargeboxId,
      protocol: ws.protocol,
      peer,
      send: (text) => {
        ws.send(text);
      },
      close: () => {
        ws.terminate();
      },
    };
    this.connections.set(chargeboxId, connection);
    ws.on("message", (data) => {
      void peer.handleMessage(rawDataToString(data));
    });
    ws.on("close", () => {
      if (this.connections.get(chargeboxId) === connection) {
        this.connections.delete(chargeboxId);
      }
      peer.cancelAll(new Error("closed"));
    });
    for (const waiter of this.#connectionWaiters.filter(
      (candidate) => candidate.id === chargeboxId,
    )) {
      this.#connectionWaiters.splice(this.#connectionWaiters.indexOf(waiter), 1);
      waiter.resolve(connection);
    }
  }

  /** Calls an action on a connected charger. */
  call<A extends CentralSystemAction>(
    chargeboxId: string,
    action: A,
    request: OcppRequest<A>,
  ): Promise<OcppResponse<A>> {
    return this.connection(chargeboxId).peer.call(action, request);
  }
}
