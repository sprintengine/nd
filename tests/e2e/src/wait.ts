/** Resolves after `ms` milliseconds. */
export const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Resolves at `instant` (at once if it has passed). */
export const sleepUntil = (instant: Date) => sleep(Math.max(0, instant.getTime() - Date.now()));

/**
 * Calls `probe` until it returns something other than undefined, and returns
 * that. Fails after `timeoutMs` with `what` and the last error, if any.
 */
export async function eventually<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const { timeoutMs = 20_000, intervalMs = 250 } = options;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      const reason = lastError instanceof Error ? `: ${lastError.message}` : "";
      throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what}${reason}`);
    }
    await sleep(intervalMs);
  }
}
