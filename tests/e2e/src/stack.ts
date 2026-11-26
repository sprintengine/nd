import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { API_URL, STRIPE_DOUBLE_URL } from "./config.ts";
import { eventually } from "./wait.ts";

// Vitest's global setup: brings up infra/compose.e2e.yml (built images,
// Postgres, stripe-mock and the Stripe double) before the scenarios and takes
// it down after them, leaving the stack's logs in tests/e2e/stack.log.
//
//   E2E_NO_BUILD=1     use the app images as already built (CI builds them first)
//   E2E_KEEP_STACK=1   leave the stack running afterwards
//   E2E_API_URL=...    use a stack that is already running; start nothing

const COMPOSE_FILE = fileURLToPath(new URL("../../../infra/compose.e2e.yml", import.meta.url));
const LOG_FILE = fileURLToPath(new URL("../stack.log", import.meta.url));

function compose(...args: string[]): string {
  const result = spawnSync("docker", ["compose", "--file", COMPOSE_FILE, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(" ")} failed (${String(result.status)})`);
  }
  return result.stdout;
}

async function ready(url: string): Promise<void> {
  await eventually(
    url,
    async () => ((await fetch(url).catch(() => undefined))?.ok === true ? true : undefined),
    { timeoutMs: 60_000, intervalMs: 500 },
  );
}

export default async function setup(): Promise<(() => void) | undefined> {
  if (process.env.E2E_API_URL !== undefined) {
    await ready(`${API_URL}/readyz`);
    return undefined;
  }
  const keep = process.env.E2E_KEEP_STACK === "1";
  const teardown = () => {
    try {
      writeFileSync(LOG_FILE, compose("logs", "--no-color", "--timestamps"));
    } finally {
      if (!keep) compose("down", "--volumes", "--remove-orphans");
    }
  };
  try {
    if (process.env.E2E_NO_BUILD === "1") {
      // The Stripe double is one file on a distroless base: always built here.
      compose("build", "stripe-double");
      compose("up", "--detach", "--wait", "--wait-timeout", "300", "--no-build");
    } else {
      compose("up", "--detach", "--wait", "--wait-timeout", "300", "--build");
    }
    await ready(`${API_URL}/readyz`);
    await ready(`${STRIPE_DOUBLE_URL}/__double/health`);
  } catch (error) {
    teardown();
    throw error;
  }
  return teardown;
}
