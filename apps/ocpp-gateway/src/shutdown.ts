/** How long a shutdown may take before the process exits anyway. Below Docker's stop grace period. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/** Options for {@link closeOnSignal}. Tests replace the process hooks. */
export interface ShutdownOptions {
  readonly timeoutMs?: number;
  readonly signals?: readonly NodeJS.Signals[];
  readonly target?: Pick<NodeJS.Process, "on">;
  readonly exit?: (code: number) => void;
  readonly log?: (message: string) => void;
}

/**
 * Runs `close` once on SIGTERM or SIGINT (what `docker stop` and Ctrl-C send),
 * then exits 0. Exits 1 if closing fails, takes longer than the timeout, or a
 * second signal arrives while closing.
 */
export function closeOnSignal(close: () => Promise<void>, options: ShutdownOptions = {}): void {
  const {
    timeoutMs = SHUTDOWN_TIMEOUT_MS,
    signals = ["SIGTERM", "SIGINT"],
    target = process,
    exit = (code: number) => process.exit(code),
    log = (message: string) => {
      console.info(message);
    },
  } = options;
  let closing = false;

  const onSignal = (signal: NodeJS.Signals): void => {
    if (closing) {
      log(`${signal} received while shutting down, exiting now`);
      exit(1);
      return;
    }
    closing = true;
    log(`${signal} received, shutting down`);
    const timer = setTimeout(() => {
      log(`shutdown did not finish within ${String(timeoutMs)} ms, exiting`);
      exit(1);
    }, timeoutMs);
    timer.unref();
    close().then(
      () => {
        clearTimeout(timer);
        exit(0);
      },
      (error: unknown) => {
        clearTimeout(timer);
        log(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
        exit(1);
      },
    );
  };

  for (const signal of signals) {
    target.on(signal, onSignal);
  }
}
