import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { outbox } from "../../test/fakes.ts";
import { NOW, SESSION_COOKIE, signInAs, startUnitApp, USER_ID } from "../../test/unit-app.ts";
import * as deletion from "../accounts/deletion.ts";

vi.mock("../accounts/deletion.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof deletion>();
  return {
    ...actual,
    requestDeletion: vi.fn(),
    cancelDeletion: vi.fn(),
    revokeSessions: vi.fn(),
  };
});

const DUE = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);
let app: FastifyInstance;
let mail: ReturnType<typeof outbox>;

beforeEach(() => {
  ({ app, mail } = startUnitApp());
  signInAs(app);
  vi.mocked(deletion.requestDeletion).mockResolvedValue({
    status: "scheduled",
    id: "deletion-1",
    dueAt: DUE,
  });
  vi.mocked(deletion.cancelDeletion).mockResolvedValue(true);
  vi.mocked(deletion.revokeSessions).mockResolvedValue();
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  vi.mocked(deletion.requestDeletion).mockReset();
  vi.mocked(deletion.cancelDeletion).mockReset();
  vi.mocked(deletion.revokeSessions).mockReset();
});

const requestIt = () => app.inject({ method: "POST", url: "/me/delete", headers: SESSION_COOKIE });

describe("POST /me/delete", () => {
  it("schedules the deletion, emails an undo link and signs out everywhere", async () => {
    const response = await requestIt();
    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ deletionDueAt: DUE.toISOString() });
    const [call] = vi.mocked(deletion.requestDeletion).mock.calls;
    const token = /token=([\w-]+)/.exec(mail.emails[0]?.text ?? "")?.[1] ?? "";
    expect(call?.[1]).toEqual({
      userId: USER_ID,
      now: NOW,
      undoTokenHash: deletion.hashUndoToken(token),
    });
    expect(mail.emails[0]).toMatchObject({
      to: "aoife@example.com",
      subject: "Your account will be deleted",
    });
    expect(mail.emails[0]?.text).toContain("http://localhost:5173/account/restore?token=");
    expect(deletion.revokeSessions).toHaveBeenCalledWith(expect.anything(), USER_ID);
  });

  it("lists what blocks the deletion", async () => {
    vi.mocked(deletion.requestDeletion).mockResolvedValueOnce({
      status: "blocked",
      blockers: [{ code: "open-booking", message: "You have a booking that is not finished." }],
    });
    const response = await requestIt();
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "account-deletion-blocked",
      reasons: [{ code: "open-booking" }],
    });
    expect(deletion.revokeSessions).not.toHaveBeenCalled();
  });

  it("withdraws the request when the email fails", async () => {
    mail.email.send = () => Promise.reject(new Error("down"));
    const response = await requestIt();
    expect(response.statusCode).toBe(503);
    expect(deletion.cancelDeletion).toHaveBeenCalledWith(
      expect.anything(),
      { id: "deletion-1" },
      NOW,
    );
    expect(deletion.revokeSessions).not.toHaveBeenCalled();
  });

  it("is 401 without a session", async () => {
    expect((await app.inject({ method: "POST", url: "/me/delete" })).statusCode).toBe(401);
  });
});

describe("POST /me/delete/cancel", () => {
  const cancel = (token: string) =>
    app.inject({ method: "POST", url: "/me/delete/cancel", payload: { token } });

  it("undoes a pending deletion by its token", async () => {
    const token = deletion.newUndoToken();
    const response = await cancel(token);
    expect(response.statusCode).toBe(204);
    expect(deletion.cancelDeletion).toHaveBeenCalledWith(
      expect.anything(),
      { undoTokenHash: deletion.hashUndoToken(token) },
      NOW,
    );
  });

  it("is 404 for a token that matches nothing pending", async () => {
    vi.mocked(deletion.cancelDeletion).mockResolvedValueOnce(false);
    const response = await cancel("y".repeat(43));
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "deletion-not-found" });
  });

  it("is 400 without a token", async () => {
    expect((await cancel("short")).statusCode).toBe(400);
  });
});

describe("undo tokens", () => {
  it("are random and stored only as a hash", () => {
    const token = deletion.newUndoToken();
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(deletion.newUndoToken()).not.toBe(token);
    expect(deletion.hashUndoToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(deletion.hashUndoToken(token)).not.toContain(token);
  });
});
