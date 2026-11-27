import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeOnSignal, SHUTDOWN_TIMEOUT_MS } from "./shutdown.ts";

function setup(close: () => Promise<void>, timeoutMs?: number) {
  const target = new EventEmitter();
  const exit = vi.fn<(code: number) => void>();
  const log = vi.fn<(message: string) => void>();
  closeOnSignal(close, {
    target: target as unknown as Pick<NodeJS.Process, "on">,
    exit,
    log,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  return { target, exit, log };
}

describe("closeOnSignal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes once and exits 0 on SIGTERM", async () => {
    const close = vi.fn(() => Promise.resolve());
    const { target, exit, log } = setup(close);

    target.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });

    expect(close).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("SIGTERM received, shutting down");
  });

  it("also listens for SIGINT", async () => {
    const { target, exit } = setup(() => Promise.resolve());
    target.emit("SIGINT", "SIGINT");
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  it("exits 1 when closing fails", async () => {
    const { target, exit, log } = setup(() => Promise.reject(new Error("boom")));
    target.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(1);
    });
    expect(log).toHaveBeenCalledWith("shutdown failed: boom");
  });

  it("reports non-Error rejections", async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const { target, exit, log } = setup(() => Promise.reject("nope"));
    target.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(1);
    });
    expect(log).toHaveBeenCalledWith("shutdown failed: nope");
  });

  it("exits 1 when closing takes longer than the timeout", () => {
    const { target, exit } = setup(() => new Promise<void>(() => undefined), 50);
    target.emit("SIGTERM", "SIGTERM");
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits 1 straight away on a second signal", () => {
    const close = vi.fn(() => new Promise<void>(() => undefined));
    const { target, exit } = setup(close);
    target.emit("SIGTERM", "SIGTERM");
    target.emit("SIGINT", "SIGINT");
    expect(exit).toHaveBeenCalledWith(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("logs to the console and exits the process by default", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const target = new EventEmitter();
    closeOnSignal(() => Promise.resolve(), {
      target: target as unknown as Pick<NodeJS.Process, "on">,
    });
    target.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(info).toHaveBeenCalledWith("SIGTERM received, shutting down");
    exit.mockRestore();
    info.mockRestore();
  });

  it("leaves Docker room to stop the container", () => {
    expect(SHUTDOWN_TIMEOUT_MS).toBeLessThan(15_000);
  });
});
