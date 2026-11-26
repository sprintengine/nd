import { type ServerMessage, serverMessageSchema } from "@nd/domain";
import { WebSocket } from "ws";

/** A realtime client that keeps every message the server sent. */
export interface RealtimeClient {
  readonly socket: WebSocket;
  readonly messages: ServerMessage[];
  /** Resolves with the first message (already received or still to come) matching `match`. */
  next<T extends ServerMessage>(
    match: (message: ServerMessage) => message is T,
    timeoutMs?: number,
  ): Promise<T>;
  next(match: (message: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  close(): Promise<void>;
}

/** Opens a WebSocket to the API with these headers and waits for its `ready` message. */
export async function openRealtime(
  url: string,
  headers: Record<string, string>,
): Promise<RealtimeClient> {
  const socket = new WebSocket(url, { headers });
  const messages: ServerMessage[] = [];
  const waiters = new Set<() => void>();
  socket.on("message", (data) => {
    // Every message must match the published contract.
    messages.push(serverMessageSchema.parse(JSON.parse((data as Buffer).toString("utf8"))));
    for (const wake of [...waiters]) wake();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      resolve();
    });
    socket.once("error", reject);
  });
  const next = (match: (message: ServerMessage) => boolean, timeoutMs = 10_000) =>
    new Promise<ServerMessage>((resolve, reject) => {
      let seen = 0;
      const check = () => {
        for (; seen < messages.length; seen += 1) {
          const message = messages[seen];
          if (message !== undefined && match(message)) {
            clearTimeout(timer);
            waiters.delete(check);
            resolve(message);
            return;
          }
        }
      };
      const timer = setTimeout(() => {
        waiters.delete(check);
        reject(
          new Error(
            `no matching message within ${String(timeoutMs)} ms: ${JSON.stringify(messages)}`,
          ),
        );
      }, timeoutMs);
      waiters.add(check);
      check();
    });
  const client = {
    socket,
    messages,
    next,
    close: () =>
      new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) {
          resolve();
          return;
        }
        socket.once("close", () => {
          resolve();
        });
        socket.close();
      }),
  } as RealtimeClient;
  await client.next((message) => message.type === "ready");
  return client;
}

/** The HTTP status an upgrade is refused with, or 101 when it is accepted. */
export function upgradeStatus(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers });
    socket.on("unexpected-response", (_request, response) => {
      resolve(response.statusCode ?? 0);
      socket.terminate();
    });
    socket.on("open", () => {
      resolve(101);
      socket.close();
    });
    socket.on("error", () => undefined);
  });
}

/** A type guard for one message type. */
export const ofType =
  <T extends ServerMessage["type"]>(type: T) =>
  (message: ServerMessage): message is Extract<ServerMessage, { type: T }> =>
    message.type === type;
