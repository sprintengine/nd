import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MiniCsms } from "../testing/mini-csms.ts";
import { COMMANDS, parseCliArgs, runCli, runCommand, USAGE, UsageError } from "./cli.ts";
import { startZappiSim } from "./index.ts";

const ID = "21234567";
const SECRET = "test-secret-not-real";

describe("parseCliArgs", () => {
  it("reads the options, skipping the -- pnpm passes through", () => {
    expect(
      parseCliArgs([
        "--",
        "--url",
        "ws://localhost:9000/v16/",
        "--id",
        ID,
        "--secret",
        SECRET,
        "--kw",
        "11",
        "--start-delay",
        "500",
        "--meter-wh",
        "1000",
        "--locked",
        "--reconnect-ms",
        "100",
        "--insecure",
        "--quiet",
      ]),
    ).toEqual({
      help: false,
      quiet: true,
      sim: {
        url: "ws://localhost:9000/v16/",
        chargeboxId: ID,
        secret: SECRET,
        chargeRateKw: 11,
        startDelayMs: 500,
        meterWh: 1000,
        config: { FreeCharging: false },
        autoReconnectMs: 100,
        rejectUnauthorized: false,
      },
    });
  });

  it("defaults the reconnect delay", () => {
    expect(parseCliArgs(["--url", "wss://ocpp.example.com/v16/", "--id", ID]).sim).toEqual({
      url: "wss://ocpp.example.com/v16/",
      chargeboxId: ID,
      autoReconnectMs: 5000,
    });
  });

  it("supports --help", () => {
    expect(parseCliArgs(["--help"]).help).toBe(true);
  });

  it.each([
    [["--id", ID], "--url and --id are required"],
    [["--url", "http://x/", "--id", ID], "must start with ws://"],
    [["--url", "ws://x/", "--id", ID, "--kw", "fast"], "--kw must be a non-negative number"],
    [["--url", "ws://x/", "--id", ID, "--start-delay", "-1"], "--start-delay"],
    [["--bogus"], "Unknown option"],
  ])("rejects %j", (argv, message) => {
    expect(() => parseCliArgs(argv)).toThrow(UsageError);
    expect(() => parseCliArgs(argv)).toThrow(message);
  });
});

describe("runCli", () => {
  let csms: MiniCsms;

  beforeEach(async () => {
    csms = await MiniCsms.start({ secrets: { [ID]: SECRET }, heartbeatInterval: 1 });
  });

  afterEach(async () => {
    await csms.close();
  });

  function io(stdin?: PassThrough) {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: {
        stdout: (line: string) => out.push(line),
        stderr: (line: string) => err.push(line),
        ...(stdin ? { stdin } : {}),
      },
    };
  }

  it("prints help", async () => {
    const { out, io: cliIo } = io();
    await expect(runCli(["--help"], cliIo)).resolves.toBe(0);
    expect(out[0]).toContain(USAGE);
    expect(out[0]).toContain(COMMANDS);
  });

  it("exits 2 on bad arguments and 1 when it cannot connect", async () => {
    const bad = io();
    await expect(runCli(["--url", "ws://x/"], bad.io)).resolves.toBe(2);
    expect(bad.err[0]).toContain("--url and --id are required");
    const refused = io();
    await expect(
      runCli(["--url", csms.url, "--id", ID, "--secret", "wrong"], refused.io),
    ).resolves.toBe(1);
    expect(refused.err[0]).toContain("401");
  });

  it("boots, heartbeats and answers a RemoteStart from a scripted server", async () => {
    const stdin = new PassThrough();
    const { out, err, io: cliIo } = io(stdin);
    const run = runCli(
      ["--", "--url", csms.url, "--id", ID, "--secret", SECRET, "--locked", "--start-delay", "0"],
      cliIo,
    );
    await csms.waitForCall("BootNotification");
    await csms.waitForCall("Heartbeat");
    stdin.write("plug\n");
    await csms.waitForCall("StatusNotification", {
      predicate: (status) => status.status === "Preparing",
    });
    await expect(csms.call(ID, "RemoteStartTransaction", { idTag: "booking-1" })).resolves.toEqual({
      status: "Accepted",
    });
    await csms.waitForCall("StartTransaction");
    stdin.write("bogus\n\nquit\n");
    await expect(run).resolves.toBe(0);
    expect(
      out.some((line) => line.startsWith("-> [2,") && line.includes('"BootNotification"')),
    ).toBe(true);
    expect(out.some((line) => line.startsWith("<- [3,"))).toBe(true);
    expect(out).toContain("plugged in");
    expect(out).toContain("unknown command bogus; try help");
    expect(err).toEqual([]);
  });

  it("keeps quiet with --quiet, reports failing commands, and stops at end of input", async () => {
    const stdin = new PassThrough();
    const { out, err, io: cliIo } = io(stdin);
    const run = runCli(["--url", csms.url, "--id", ID, "--secret", SECRET, "--quiet"], cliIo);
    await csms.waitForConnection(ID);
    await vi.waitFor(() => {
      expect(out.some((line) => line.includes("BootNotification: Accepted"))).toBe(true);
    });
    stdin.write("disconnect\n");
    stdin.write("pin 1234\n");
    stdin.end();
    await expect(run).resolves.toBe(0);
    expect(out.some((line) => line.startsWith("->"))).toBe(false);
    expect(err).toEqual(["The simulator is not connected"]);
  });

  it("returns once started when there is no stdin", async () => {
    const { io: cliIo } = io();
    await expect(runCli(["--url", csms.url, "--id", ID, "--secret", SECRET], cliIo)).resolves.toBe(
      0,
    );
    await csms.waitForConnection(ID);
    csms.connection(ID).close();
  });
});

describe("runCommand", () => {
  it("drives every control", async () => {
    const csms = await MiniCsms.start({ secrets: { [ID]: SECRET } });
    const sim = await startZappiSim({
      url: csms.url,
      chargeboxId: ID,
      secret: SECRET,
      startDelayMs: 0,
    });
    try {
      const run = (line: string) => runCommand(sim, line);
      expect(await run("help")).toBe(COMMANDS);
      expect(await run("   ")).toBe("");
      expect(await run("plug")).toBe("plugged in");
      await sim.waitForStatus("Charging");
      expect(await run("suspend-ev")).toBe("car suspended");
      expect(sim.state.status).toBe("SuspendedEV");
      expect(await run("resume-ev")).toBe("car resumed");
      expect(await run("pin")).toBe("usage: pin <idTag>");
      expect(await run("pin 1234")).toBe("Authorize 1234: Accepted");
      expect(await run("meter")).toBe("MeterValues sent");
      expect(await run("heartbeat")).toBe("Heartbeat sent");
      expect(JSON.parse((await run("status")) ?? "{}")).toMatchObject({
        status: "Charging",
        plugged: true,
      });
      expect(await run("fault")).toBe("faulted (OtherError)");
      expect(await run("fault NoError")).toBe("unknown error code NoError");
      expect(await run("fault HighTemperature")).toBe("faulted (HighTemperature)");
      expect(await run("clear")).toBe("fault cleared");
      expect(await run("delay 10")).toBe("replies delayed by 10 ms");
      expect(sim.faults.replyDelayMs).toBe(10);
      expect(await run("delay soon")).toBe("usage: delay <ms>");
      expect(await run("ignore Reset,UnlockConnector")).toBe("ignoring Reset, UnlockConnector");
      expect(sim.faults.ignoreCalls).toEqual(["Reset", "UnlockConnector"]);
      expect(await run("ignore")).toBe("answering every call");
      expect(await run("no-start")).toBe("StartTransaction suppressed");
      expect(await run("no-start off")).toBe("StartTransaction enabled");
      expect(await run("no-stop")).toBe("StopTransaction suppressed");
      expect(await run("no-stop off")).toBe("StopTransaction enabled");
      expect(await run("unplug")).toBe("unplugged");
      expect(await run("disconnect")).toBe("socket dropped");
      await sim.waitForDisconnect().catch(() => undefined);
      expect(await run("reconnect")).toBe("reconnected");
      expect(await run("exit")).toBeUndefined();
      expect(await run("quit")).toBeUndefined();
    } finally {
      await sim.stop();
      await csms.close();
    }
  });
});
