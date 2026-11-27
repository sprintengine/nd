import { rawDataToString } from "@nd/ocpp-core/sim";
import WebSocket from "ws";

import { API_URL, APP_ORIGIN } from "./config.ts";
import type { ApiClient } from "./http.ts";
import { eventually } from "./wait.ts";

/** A message from the API's realtime feed (GET /ws). */
export interface FeedMessage {
  readonly type: string;
  readonly bookingId?: string;
  readonly status?: string;
  readonly [key: string]: unknown;
}

/** One person's realtime feed, as the app opens it: the session cookie and the app's Origin. */
export class Feed {
  readonly messages: FeedMessage[] = [];

  readonly #socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data: WebSocket.RawData) => {
      this.messages.push(JSON.parse(rawDataToString(data)) as FeedMessage);
    });
  }

  /** Opens the feed and waits for its `ready` message. */
  static async open(api: ApiClient): Promise<Feed> {
    const socket = new WebSocket(`${API_URL.replace(/^http/, "ws")}/ws`, {
      headers: { cookie: api.cookie, origin: APP_ORIGIN },
    });
    const feed = new Feed(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => {
        resolve();
      });
      socket.once("error", reject);
      socket.once("unexpected-response", (_request, response) => {
        reject(new Error(`the realtime feed refused: ${String(response.statusCode)}`));
      });
    });
    await feed.next("ready", () => true);
    return feed;
  }

  /** Resolves with the first message (seen so far or later) of `type` matching `match`. */
  next(type: string, match: (message: FeedMessage) => boolean, timeoutMs = 30_000) {
    return eventually(
      `a ${type} message`,
      () =>
        Promise.resolve(this.messages.find((message) => message.type === type && match(message))),
      { timeoutMs, intervalMs: 100 },
    );
  }

  close(): void {
    this.#socket.close();
  }
}
