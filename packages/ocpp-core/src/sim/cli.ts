/**
 * Runs a simulated Zappi against a central system:
 *
 *   pnpm --filter @nd/ocpp-core sim -- --url ws://localhost:9000/v16/ --id 21234567 --secret s3cret
 *
 * Every OCPP frame is printed. Type commands on stdin to drive the charger
 * (`help` lists them).
 */

import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

import type { CentralSystemAction } from "../actions.ts";
import { ChargePointErrorCode } from "../schemas/charge-point.ts";
import { startZappiSim } from "./index.ts";
import type { ZappiSim, ZappiSimOptions } from "./zappi.ts";

export const USAGE = `Usage: sim --url <ws(s)://host/path/> --id <chargeboxId> [options]

  --url <url>            central system URL; the chargebox id is appended
  --id <id>              chargebox id (also the Basic Auth username)
  --secret <secret>      Basic Auth password
  --kw <kW>              charging power (default 7.2)
  --start-delay <ms>     delay before StartTransaction once unlocked (default 1000)
  --meter-wh <Wh>        starting energy register (default 0)
  --locked               start with FreeCharging=false
  --reconnect-ms <ms>    reconnect delay after a dropped socket (default 5000)
  --insecure             do not verify the server's TLS certificate
  --quiet                do not print frames
  --help                 show this help`;

export const COMMANDS = `Commands:
  plug | unplug                 plug a car in or out
  pin <idTag>                   enter a PIN (sends Authorize)
  suspend-ev | resume-ev        the car stops or resumes drawing power
  fault [errorCode] | clear     report Faulted, or clear the fault
  disconnect | reconnect        drop the socket, or connect again
  delay <ms>                    delay replies to the central system
  ignore [Action,...]           never answer these actions (none to clear)
  no-start | no-stop [off]      never send StartTransaction / StopTransaction
  meter | heartbeat             send MeterValues or Heartbeat now
  status                        print the charger state
  quit                          close the connection and exit`;

export class UsageError extends Error {
  override readonly name = "UsageError";
}

export interface CliOptions {
  readonly help: boolean;
  readonly quiet: boolean;
  readonly sim: ZappiSimOptions;
}

function number(name: string, value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new UsageError(`--${name} must be a non-negative number`);
  }
  return parsed;
}

/** Parses the command line. pnpm passes a leading `--` through, which is skipped. */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  let values;
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      options: {
        url: { type: "string" },
        id: { type: "string" },
        secret: { type: "string" },
        kw: { type: "string" },
        "start-delay": { type: "string" },
        "meter-wh": { type: "string" },
        locked: { type: "boolean", default: false },
        "reconnect-ms": { type: "string" },
        insecure: { type: "boolean", default: false },
        quiet: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    }));
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  if (values.help) {
    return { help: true, quiet: values.quiet, sim: { url: "", chargeboxId: "" } };
  }
  if (values.url === undefined || values.id === undefined) {
    throw new UsageError("--url and --id are required");
  }
  if (!/^wss?:\/\//.test(values.url)) {
    throw new UsageError("--url must start with ws:// or wss://");
  }
  const chargeRateKw = number("kw", values.kw);
  const startDelayMs = number("start-delay", values["start-delay"]);
  const meterWh = number("meter-wh", values["meter-wh"]);
  const sim: ZappiSimOptions = {
    url: values.url,
    chargeboxId: values.id,
    autoReconnectMs: number("reconnect-ms", values["reconnect-ms"]) ?? 5000,
    ...(values.secret === undefined ? {} : { secret: values.secret }),
    ...(chargeRateKw === undefined ? {} : { chargeRateKw }),
    ...(startDelayMs === undefined ? {} : { startDelayMs }),
    ...(meterWh === undefined ? {} : { meterWh }),
    ...(values.locked ? { config: { FreeCharging: false } } : {}),
    ...(values.insecure ? { rejectUnauthorized: false } : {}),
  };
  return { help: false, quiet: values.quiet, sim };
}

/**
 * Runs one stdin command against the simulator and returns what to print.
 * Returns `undefined` for `quit`.
 */
export async function runCommand(sim: ZappiSim, line: string): Promise<string | undefined> {
  const [command = "", ...args] = line.trim().split(/\s+/);
  const arg = args[0];
  switch (command) {
    case "":
      return "";
    case "plug":
      sim.plugIn();
      return "plugged in";
    case "unplug":
      sim.unplug();
      return "unplugged";
    case "pin": {
      if (arg === undefined) {
        return "usage: pin <idTag>";
      }
      const response = await sim.enterPin(arg);
      return `Authorize ${arg}: ${response.idTagInfo.status}`;
    }
    case "suspend-ev":
      sim.suspendEv();
      return "car suspended";
    case "resume-ev":
      sim.resumeEv();
      return "car resumed";
    case "fault": {
      const code = ChargePointErrorCode.exclude(["NoError"]).safeParse(arg ?? "OtherError");
      if (!code.success) {
        return `unknown error code ${String(arg)}`;
      }
      sim.fault(code.data);
      return `faulted (${code.data})`;
    }
    case "clear":
      sim.clearFault();
      return "fault cleared";
    case "disconnect":
      sim.disconnect();
      return "socket dropped";
    case "reconnect":
      await sim.reconnect();
      return "reconnected";
    case "delay": {
      const ms = Number(arg ?? "0");
      if (!Number.isFinite(ms) || ms < 0) {
        return "usage: delay <ms>";
      }
      sim.setFaults({ replyDelayMs: ms });
      return `replies delayed by ${String(ms)} ms`;
    }
    case "ignore": {
      const actions = (arg ?? "")
        .split(",")
        .filter((action) => action !== "") as CentralSystemAction[];
      sim.setFaults({ ignoreCalls: actions });
      return actions.length === 0 ? "answering every call" : `ignoring ${actions.join(", ")}`;
    }
    case "no-start":
      sim.setFaults({ neverSendStartTransaction: arg !== "off" });
      return `StartTransaction ${arg === "off" ? "enabled" : "suppressed"}`;
    case "no-stop":
      sim.setFaults({ neverSendStopTransaction: arg !== "off" });
      return `StopTransaction ${arg === "off" ? "enabled" : "suppressed"}`;
    case "meter":
      await sim.sendMeterValues();
      return "MeterValues sent";
    case "heartbeat":
      await sim.heartbeat();
      return "Heartbeat sent";
    case "status":
      return JSON.stringify(sim.state, null, 2);
    case "help":
      return COMMANDS;
    case "quit":
    case "exit":
      return undefined;
    default:
      return `unknown command ${command}; try help`;
  }
}

export interface CliIo {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  readonly stdin?: NodeJS.ReadableStream;
}

/**
 * Starts the simulator from command-line arguments and, when `io.stdin` is
 * given, reads commands from it until `quit` or end of input. Resolves with
 * the exit code once the simulator has stopped.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    io.stderr(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    io.stdout(`${USAGE}\n\n${COMMANDS}`);
    return 0;
  }
  // Listen before connecting, so the BootNotification exchange is printed too.
  const sim = await startZappiSim({ ...options.sim, log: io.stdout, connect: false });
  if (!options.quiet) {
    sim.on("frame", ({ direction, raw }) => {
      io.stdout(`${direction === "out" ? "->" : "<-"} ${raw}`);
    });
  }
  try {
    await sim.connect();
  } catch (error) {
    await sim.stop();
    io.stderr(`could not connect: ${(error as Error).message}`);
    return 1;
  }
  if (io.stdin === undefined) {
    return 0;
  }
  const lines = createInterface({ input: io.stdin, terminal: false });
  for await (const line of lines) {
    try {
      const output = await runCommand(sim, line);
      if (output === undefined) {
        break;
      }
      if (output !== "") {
        io.stdout(output);
      }
    } catch (error) {
      io.stderr((error as Error).message);
    }
  }
  lines.close();
  await sim.stop();
  return 0;
}

/* v8 ignore next 9 -- process entry point, exercised by running the CLI */
if (import.meta.main) {
  const code = await runCli(process.argv.slice(2), {
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    stdin: process.stdin,
  });
  process.exit(code);
}
