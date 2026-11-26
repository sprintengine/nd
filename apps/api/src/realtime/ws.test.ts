import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { fakeChargerEvents } from "../../test/fakes.ts";
import { APP_ORIGIN } from "../../test/http.ts";
import { signInAs, startUnitApp } from "../../test/unit-app.ts";

let app: FastifyInstance;
let events: ReturnType<typeof fakeChargerEvents>;
const sockets: Awaited<ReturnType<FastifyInstance["injectWS"]>>[] = [];
const headers = { cookie: "better-auth.session_token=abc", origin: APP_ORIGIN };

/** Opens a socket and collects its messages from the first one on. */
async function open(upgradeHeaders: Record<string, string> = headers) {
  const messages: unknown[] = [];
  const socket = await app.injectWS(
    "/ws",
    { headers: upgradeHeaders },
    {
      onInit: (ws) => {
        ws.on("message", (data) => messages.push(JSON.parse((data as Buffer).toString("utf8"))));
      },
    },
  );
  sockets.push(socket);
  const until = async (count: number) => {
    for (let tries = 0; messages.length < count && tries < 100; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return messages;
  };
  return { socket, messages, until };
}

beforeEach(async () => {
  ({ app, events } = startUnitApp());
  signInAs(app);
  await app.ready();
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await app.close();
});

describe("GET /ws", () => {
  it("accepts a signed-in user, says it is ready and answers a ping", async () => {
    const client = await open();
    expect(await client.until(1)).toEqual([{ type: "ready", heartbeatSeconds: 30 }]);
    client.socket.send(JSON.stringify({ type: "ping" }));
    client.socket.send("nonsense");
    client.socket.send(Buffer.from([1, 2, 3]), { binary: true });
    expect(await client.until(2)).toEqual([
      { type: "ready", heartbeatSeconds: 30 },
      { type: "pong" },
    ]);
  });

  it("passes the dispatcher's resync on to every connection", async () => {
    const client = await open();
    await client.until(1);
    events.signal({ kind: "resync" });
    expect((await client.until(2))[1]).toEqual({ type: "resync" });
  });

  it("refuses an untrusted origin, no session, and too many connections", async () => {
    await expect(open({ ...headers, origin: "https://evil.example" })).rejects.toThrow(/403/);
    for (let count = 0; count < 5; count += 1) await open();
    await expect(open()).rejects.toThrow(/429/);
    vi.mocked(app.auth.api.getSession).mockResolvedValue({
      headers: new Headers(),
      response: null,
    } as never);
    await expect(open({ origin: APP_ORIGIN })).rejects.toThrow(/401/);
  });
});
