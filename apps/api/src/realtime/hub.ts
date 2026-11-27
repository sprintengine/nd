import { REALTIME_HEARTBEAT_SECONDS, type ServerMessage } from "@nd/domain";

// Open realtime connections, per user. Sends a message to the users entitled
// to it, pings every connection on a timer and drops the ones that stop
// answering, re-checks each connection's sign-in now and then, and drops a
// client that cannot keep up rather than buffering without bound.

/** WebSocket readyState of an open socket. */
const OPEN = 1;

/** Close code: the user's sign-in ended. */
export const SESSION_ENDED_CLOSE_CODE = 4001;
/** Close code: the server is shutting down. */
const GOING_AWAY_CLOSE_CODE = 1001;

/** The part of a `ws` WebSocket the hub uses. */
export interface HubSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  ping(): void;
  terminate(): void;
  close(code?: number, reason?: string): void;
  on(event: "pong" | "close", listener: () => void): unknown;
}

export interface RealtimeHubOptions {
  /** Most open connections one user may hold. */
  readonly maxConnectionsPerUser: number;
  /** Time between pings; a connection that has not answered the previous ping is dropped. */
  readonly heartbeatMs: number;
  /** A connection with more unsent bytes than this is dropped; the client reconnects and refetches. */
  readonly maxBufferedBytes: number;
  /** Re-check each connection's sign-in every this many heartbeats. */
  readonly revalidateEveryBeats: number;
  readonly log: { warn(details: object, message: string): void };
}

export const DEFAULT_HUB_OPTIONS = {
  maxConnectionsPerUser: 5,
  heartbeatMs: REALTIME_HEARTBEAT_SECONDS * 1000,
  maxBufferedBytes: 1024 * 1024,
  revalidateEveryBeats: 10,
} as const;

interface Connection {
  readonly userId: string;
  readonly socket: HubSocket;
  /** Whether the user's sign-in is still valid. */
  readonly validate: () => Promise<boolean>;
  alive: boolean;
}

export interface RealtimeHub {
  /**
   * Adds a connection for a signed-in user. Returns false (and adds nothing)
   * when the user already holds the most connections allowed.
   */
  add(userId: string, socket: HubSocket, validate: () => Promise<boolean>): boolean;
  /** How many connections a user holds. */
  count(userId: string): number;
  /** Whether any of these users is connected. */
  anyConnected(userIds: Iterable<string>): boolean;
  /** Sends a message to every connection of each user (each user once). */
  send(userIds: Iterable<string>, message: ServerMessage): void;
  /** Sends a message to one socket. */
  sendTo(socket: HubSocket, message: ServerMessage): void;
  /** Sends a message to everyone connected. */
  broadcast(message: ServerMessage): void;
  /** Stops the heartbeat and closes every connection. */
  close(): void;
}

export function createRealtimeHub(options: RealtimeHubOptions): RealtimeHub {
  const byUser = new Map<string, Set<Connection>>();
  let beats = 0;

  const remove = (connection: Connection) => {
    const set = byUser.get(connection.userId);
    if (set === undefined) return;
    set.delete(connection);
    if (set.size === 0) byUser.delete(connection.userId);
  };

  const write = (connection: Connection, data: string) => {
    const { socket } = connection;
    if (socket.readyState !== OPEN) return;
    if (socket.bufferedAmount > options.maxBufferedBytes) {
      options.log.warn(
        { userId: connection.userId, bufferedAmount: socket.bufferedAmount },
        "realtime client is not keeping up; dropped",
      );
      remove(connection);
      socket.terminate();
      return;
    }
    socket.send(data);
  };

  const revalidate = (connection: Connection) => {
    connection.validate().then(
      (valid) => {
        if (valid) return;
        remove(connection);
        connection.socket.close(SESSION_ENDED_CLOSE_CODE, "session ended");
      },
      () => undefined,
    );
  };

  const timer = setInterval(() => {
    beats += 1;
    const check = beats % options.revalidateEveryBeats === 0;
    for (const set of [...byUser.values()]) {
      for (const connection of [...set]) {
        if (!connection.alive) {
          remove(connection);
          connection.socket.terminate();
          continue;
        }
        connection.alive = false;
        connection.socket.ping();
        if (check) revalidate(connection);
      }
    }
  }, options.heartbeatMs);
  timer.unref();

  return {
    add(userId, socket, validate) {
      const set = byUser.get(userId) ?? new Set<Connection>();
      if (set.size >= options.maxConnectionsPerUser) return false;
      const connection: Connection = { userId, socket, validate, alive: true };
      set.add(connection);
      byUser.set(userId, set);
      socket.on("pong", () => {
        connection.alive = true;
      });
      socket.on("close", () => {
        remove(connection);
      });
      return true;
    },
    count: (userId) => byUser.get(userId)?.size ?? 0,
    anyConnected(userIds) {
      for (const userId of userIds) if (byUser.has(userId)) return true;
      return false;
    },
    send(userIds, message) {
      const data = JSON.stringify(message);
      for (const userId of new Set(userIds)) {
        for (const connection of [...(byUser.get(userId) ?? [])]) write(connection, data);
      }
    },
    sendTo(socket, message) {
      if (socket.readyState === OPEN) socket.send(JSON.stringify(message));
    },
    broadcast(message) {
      const data = JSON.stringify(message);
      for (const set of [...byUser.values()]) {
        for (const connection of [...set]) write(connection, data);
      }
    },
    close() {
      clearInterval(timer);
      for (const set of [...byUser.values()]) {
        for (const connection of set)
          connection.socket.close(GOING_AWAY_CLOSE_CODE, "server closing");
      }
      byUser.clear();
    },
  };
}
