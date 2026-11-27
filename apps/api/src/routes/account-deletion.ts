import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import {
  cancelDeletion,
  DELETION_UNDO_DAYS,
  hashUndoToken,
  newUndoToken,
  requestDeletion,
  revokeSessions,
} from "../accounts/deletion.ts";
import { requireUser, sessionOf } from "../auth/session.ts";
import type { AppDeps } from "../deps.ts";
import { HttpProblem, problemResponses } from "../http/problem.ts";
import { deletionScheduledEmail } from "../senders/templates.ts";

const deletionScheduledSchema = z
  .object({
    deletionDueAt: z.iso
      .datetime()
      .describe("When the account is anonymised, unless the deletion is undone first"),
  })
  .meta({ id: "AccountDeletionScheduled" });

const cancelBody = z.object({
  token: z.string().min(20).max(200).describe("The token from the undo link in the deletion email"),
});

export function registerAccountDeletionRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { database, clock, config, email } = deps;
  const db = database.db;
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    "/me/delete",
    {
      onRequest: requireUser,
      schema: {
        summary: "Delete your account",
        description: `Schedules the account for deletion in ${String(DELETION_UNDO_DAYS)} days and signs it out on every device at once. Until then it cannot be signed in to; the emailed link undoes the request (POST /me/delete/cancel). After that, personal data is removed; past bookings and payments are kept without it, for accounting. Refused (409, with reasons) while a booking is not finished or a payment is still owed.`,
        tags: ["account"],
        response: { 202: deletionScheduledSchema, ...problemResponses(401, 409, 503) },
      },
    },
    async (request, reply) => {
      const { userId, email: to } = sessionOf(request);
      const token = newUndoToken();
      const result = await requestDeletion(db, {
        userId,
        now: clock.now(),
        undoTokenHash: hashUndoToken(token),
      });
      if (result.status === "blocked") {
        throw new HttpProblem(
          409,
          "account-deletion-blocked",
          "Your account cannot be deleted yet",
          result.blockers.map((blocker) => blocker.message).join(" "),
          { reasons: [...result.blockers] },
        );
      }
      try {
        await email.send({
          to,
          ...deletionScheduledEmail({
            undoUrl: `${config.publicAppUrl}/account/restore?token=${token}`,
            dueAt: result.dueAt,
          }),
        });
      } catch (error) {
        // Without the email there is no way to undo: take the request back.
        request.log.warn({ err: error }, "account deletion email not sent; request withdrawn");
        await cancelDeletion(db, { id: result.id }, clock.now());
        throw new HttpProblem(
          503,
          "email-unavailable",
          "We could not send the confirmation email",
          "Nothing was changed. Try again later.",
        );
      }
      await revokeSessions(db, userId);
      void reply.code(202);
      return { deletionDueAt: result.dueAt.toISOString() };
    },
  );

  typed.post(
    "/me/delete/cancel",
    {
      schema: {
        summary: "Undo an account deletion",
        description:
          "Keeps an account scheduled for deletion, using the token from the link in the deletion email. Works until the deletion falls due; then sign in again as usual. Needs no session: the deletion request signed every device out.",
        tags: ["account"],
        body: cancelBody,
        response: { 204: z.null().describe("Deletion undone"), ...problemResponses(400, 404) },
      },
    },
    async (request, reply) => {
      const cancelled = await cancelDeletion(
        db,
        { undoTokenHash: hashUndoToken(request.body.token) },
        clock.now(),
      );
      if (!cancelled) {
        throw new HttpProblem(
          404,
          "deletion-not-found",
          "Nothing to undo",
          "The link is not valid, was already used, or the deletion has already happened.",
        );
      }
      return reply.code(204).send(null);
    },
  );
}
