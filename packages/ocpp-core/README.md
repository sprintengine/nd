# @nd/ocpp-core

OCPP 1.6J (JSON over WebSocket) for the message subset a myenergi Zappi uses: framing, Zod schemas and TypeScript types, a transport-agnostic RPC peer, and a Zappi simulator for testing a central system without hardware.

The package imports no other `@nd` package, so it can be used on its own.

## What is covered

**Framing.** `parseFrame` and `serializeFrame` handle the three OCPP-J frames, CALL `[2, id, action, payload]`, CALLRESULT `[3, id, payload]` and CALLERROR `[4, id, code, description, details]`. `parseFrame` never throws. A malformed message gives back an error with the CALLERROR code to answer with, plus the message id whenever it can be read. `OCPP_ERROR_CODES` lists the ten 1.6 error codes, spelt as the specification spells them (`OccurenceConstraintViolation`). Message ids are random UUIDs (`createMessageId`). A CALLERROR with a code outside the list is kept as `GenericError`, and the original code goes into the details.

**Messages.** These follow the OCPP 1.6 JSON schemas: the same field names, enums as string unions, idTag at most 20 characters, the CiString length limits, RFC 3339 timestamps with a time zone, integers where the schema says integer, and no unknown properties. Each message has a request schema and a response (`.conf`) schema, and a type of the same name:

| Charger to central system | Central system to charger |
| ------------------------- | ------------------------- |
| BootNotification          | RemoteStartTransaction    |
| Heartbeat                 | RemoteStopTransaction     |
| StatusNotification        | ChangeConfiguration       |
| Authorize                 | GetConfiguration          |
| StartTransaction          | TriggerMessage            |
| StopTransaction           | Reset                     |
| MeterValues               | UnlockConnector           |
| DataTransfer              |                           |

`chargePointActions`, `centralSystemActions` and `ocppActions` map each action name to its two schemas. `OcppRequest<"StartTransaction">` and `OcppResponse<"StartTransaction">` give the payload types, so a router can be typed from end to end.

**RPC.** `PendingCalls` holds outbound calls by message id until their reply arrives, and times each one out after 30 s by default with `OcppTimeoutError`. `OcppPeer` (made with `createCentralSystemPeer` or `createChargePointPeer`) is one end of a connection, and it does not care what the transport is: give it every text message you receive and a `send` function. Outbound calls are checked against their schema before they are sent, and responses are checked when they come back. A CALLERROR reply rejects the call with an `OcppError` whose `remote` is true.

Inbound calls are checked against their schema, then passed to the handler you registered:

| Inbound problem                                      | CALLERROR                      |
| ---------------------------------------------------- | ------------------------------ |
| Action unknown to this side                          | `NotImplemented`               |
| Known action without a handler                       | `NotSupported`                 |
| Payload not an object, or an unknown property        | `FormationViolation`           |
| Required property missing                            | `OccurenceConstraintViolation` |
| Property of the wrong JSON type                      | `TypeConstraintViolation`      |
| Value out of range, too long, or not in the enum     | `PropertyConstraintViolation`  |
| Malformed frame with a readable id                   | `ProtocolError`                |
| Handler throws `OcppError`                           | that error's code              |
| Handler throws anything else, or returns a bad reply | `InternalError`                |

Handlers may be async. The CALLRESULT goes out only after the handler resolves, which lets a central system store a message before it acknowledges it.

```ts
import { WebSocketServer } from "ws";
import { createCentralSystemPeer, selectSubprotocol } from "@nd/ocpp-core";

const server = new WebSocketServer({
  port: 9000,
  handleProtocols: (offered) => selectSubprotocol(offered) ?? false,
});
server.on("connection", (ws) => {
  const peer = createCentralSystemPeer({ send: (text) => ws.send(text) });
  peer.handle("BootNotification", () => ({
    status: "Accepted",
    currentTime: new Date().toISOString(),
    interval: 300,
  }));
  ws.on("message", (data) => void peer.handleMessage(data.toString()));
  ws.on("close", () => peer.cancelAll(new Error("closed")));
});
```

## Zappi simulator

`@nd/ocpp-core/sim` acts like myenergi's cloud speaking OCPP 1.6J for one Zappi with one connector:

- It connects out to `<url><chargeboxId>`, using HTTP Basic Auth (the username is the chargebox id) and the `ocpp1.6` subprotocol.
- It sends BootNotification, then a Heartbeat at the interval the central system accepted. If the boot comes back Pending or Rejected, it tries again later.
- It sends StatusNotification on every state change: Available, Preparing, Charging, SuspendedEV, SuspendedEVSE, Finishing and Faulted.
- It keeps a configuration store that answers ChangeConfiguration and GetConfiguration:
  - `FreeCharging` (default `true`)
  - `LocalAuthListEnabled`
  - `StopTransactionOnInvalidId`
  - `OCPPChargeMode`: `Fast`, `Eco`, `Eco_Plus` or `Stop`. Values are case-sensitive, so `fast` is rejected.
  - `MeterValueSampleInterval` (default 900 s)
  - `HeartbeatInterval`

  Keys that cannot be changed are rejected and unknown keys get NotSupported. After 24 accepted writes in any rolling hour, further writes are rejected.

- RemoteStartTransaction is Accepted. StartTransaction(meterStart) follows after a configurable delay, once the car is plugged in. RemoteStart is Rejected while a transaction is open or starting, while the charger is Faulted, or when it names another connector.
- With `FreeCharging=false` the charger stays locked until a RemoteStart or an accepted Authorize. When the car is unplugged it locks again.
- `enterPin(idTag)` sends Authorize. If the tag is rejected during a transaction, the charger stops the transaction (DeAuthorized) when `StopTransactionOnInvalidId=true`, and suspends it (SuspendedEVSE) when it is false. A StartTransaction answered with anything other than Accepted is handled the same way.
- During a transaction it sends MeterValues every `MeterValueSampleInterval`, with `Energy.Active.Import.Register` (Wh) and `Power.Active.Import` (W). Energy grows at a configurable kW, and only while the status is Charging.
- RemoteStopTransaction, UnlockConnector and Reset end the transaction with StopTransaction(meterStop, reason). After a stop the connector shows Finishing while the car is still plugged in, and Available once it is unplugged. Unplugging during a transaction sends StopTransaction(EVDisconnected) and then Available.
- TriggerMessage can request BootNotification, Heartbeat, StatusNotification or MeterValues.
- Transaction messages sent while offline are queued, and go out after the next boot. The charger never has more than one CALL outstanding.

Timers use the global `setTimeout` and `Date`, so Vitest fake timers drive heartbeats, meter values, delays and the write window. If you fake timers while real sockets are in use, leave `setImmediate` and `nextTick` real: `vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })`.

### In tests

```ts
import { startZappiSim } from "@nd/ocpp-core/sim";

const sim = await startZappiSim({
  url: "ws://localhost:9000/v16/",
  chargeboxId: "21234567",
  secret: "the-charger-secret",
  startDelayMs: 0,
  config: { FreeCharging: false },
});

sim.plugIn();
await sim.waitForStatus("Preparing");
// ... the central system sends RemoteStartTransaction ...
const start = await sim.waitForSent("StartTransaction");
sim.unplug();
await sim.waitForSent("StopTransaction");
await sim.waitForStatus("Available");
await sim.stop();
```

| Controls                                             | Effect                                                                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `plugIn()`, `unplug()`                               | The driver plugs a car in or takes it out                                                                       |
| `enterPin(idTag)`                                    | Sends Authorize and acts on the answer                                                                          |
| `suspendEv()`, `resumeEv()`                          | The car stops or resumes drawing power                                                                          |
| `fault(errorCode?, info?)`, `clearFault()`           | Report Faulted, or recover                                                                                      |
| `disconnect()`                                       | Drop the socket without a close handshake                                                                       |
| `reconnect({ boot? })`                               | Drop the socket if open, then connect again, with or without a new BootNotification                             |
| `setFaults({ ... })`                                 | `replyDelayMs`, `ignoreCalls` (actions or a predicate), `neverSendStartTransaction`, `neverSendStopTransaction` |
| `heartbeat()`, `sendMeterValues()`, `dataTransfer()` | Send these messages now                                                                                         |
| `stop()`                                             | Close cleanly and clear every timer                                                                             |

| Assertion hooks                                        | Returns                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `state`                                                | Connection, registration, status, plug, charge mode, meter, transaction, config             |
| `frames`                                               | Every frame sent and received                                                               |
| `sent(action)`, `received(action)`                     | Payloads of the CALLs for one action                                                        |
| `waitForSent(action, { predicate, since, timeoutMs })` | The first matching outbound CALL (pass `since: sim.frames.length` to wait for the next one) |
| `waitForStatus(status)`, `waitForDisconnect()`         | Resolves when the status or disconnect happens                                              |

Events: `frame`, `status`, `connected`, `disconnected`, `booted`, `transactionStarted`, `transactionStopped`, `ignored`, and `problem` (failures the simulator survives).

Other options are `chargeRateKw` (7.2), `startDelayMs` (1000), `meterWh`, `callTimeoutMs` (30 s), `autoReconnectMs` (off), `resetDelayMs`, `freeChargingIdTag`, `tethered`, `rejectUnauthorized` and `log`.

### Command line

```sh
pnpm --filter @nd/ocpp-core sim -- --url ws://localhost:9000/v16/ --id 21234567 --secret <secret>
```

The command prints every frame (`->` sent, `<-` received) and reads commands on stdin until `quit`, or until stdin closes. Type `help` to list the commands: `plug`, `unplug`, `pin <idTag>`, `suspend-ev`, `resume-ev`, `fault [code]`, `clear`, `disconnect`, `reconnect`, `delay <ms>`, `ignore <Action,...>`, `no-start`, `no-stop`, `meter`, `heartbeat`, `status`. The options are:

| Option           | Meaning                                                            |
| ---------------- | ------------------------------------------------------------------ |
| `--url`, `--id`  | Central system URL (the chargebox id is appended) and chargebox id |
| `--secret`       | Basic Auth password                                                |
| `--kw`           | Charging power (default 7.2)                                       |
| `--start-delay`  | Milliseconds from unlock to StartTransaction (default 1000)        |
| `--meter-wh`     | Starting energy register                                           |
| `--locked`       | Start with `FreeCharging=false`                                    |
| `--reconnect-ms` | Reconnect delay after a dropped socket (default 5000)              |
| `--insecure`     | Do not verify the server's TLS certificate (wss)                   |
| `--quiet`        | Do not print frames                                                |

## Not covered

This package does not implement OCPP 2.0.1, or 1.6 features a Zappi does not use: reservations, local authorisation lists, smart charging profiles (other than as the optional field RemoteStartTransaction carries), firmware and diagnostics.
