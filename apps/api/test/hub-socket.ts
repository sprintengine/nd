import { EventEmitter } from "node:events";

import type { HubSocket } from "../src/realtime/hub.ts";

/** A socket for the realtime hub that records what it was sent. */
export class FakeHubSocket extends EventEmitter implements HubSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: unknown[] = [];
  pings = 0;
  terminated = false;
  closed: { code: number | undefined; reason: string | undefined } | undefined;

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  ping(): void {
    this.pings += 1;
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit("close");
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
    this.emit("close");
  }
}
