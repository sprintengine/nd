import { randomBytes } from "node:crypto";

import {
  accountDeletions,
  authAccounts,
  bookings,
  chargers,
  deviceTokens,
  type Executor,
  hosts,
  hostTaxDetails,
  payments,
  refunds,
  reviews,
  sessions,
  users,
} from "@nd/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Harness, startHarness } from "../../test/harness.ts";
import { APP_ORIGIN, magicLinkPath } from "../../test/http.ts";
import { purgeExpiredTaxRecords } from "../compliance/retention.ts";
import { stripePaymentsFrom } from "../stripe/payments.ts";
import {
  DELETION_UNDO_DAYS,
  type DeletionOptions,
  hashUndoToken,
  processDueDeletions as processDue,
} from "./deletion.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
let now = new Date();
let h: Harness;

let options: DeletionOptions;

beforeAll(async () => {
  h = await startHarness({ clock: { now: () => now } });
  options = { payments: stripePaymentsFrom(h.stripeMock.sdk), taxRecordRetentionYears: 6 };
});

/** The scheduled step, deleting Stripe Customers through stripe-mock. */
const processDueDeletions = (db: Executor, at: Date) => processDue(db, at, options);

afterAll(async () => {
  await h.close();
});

const me = (cookie: string) => h.app.inject({ method: "GET", url: "/me", headers: { cookie } });
const requestDeletion = (cookie: string) =>
  h.app.inject({ method: "POST", url: "/me/delete", headers: { cookie } });
const undo = (token: string) =>
  h.app.inject({ method: "POST", url: "/me/delete/cancel", payload: { token } });

/** The undo token from the newest deletion email to `email`. */
function undoToken(email: string): string {
  const message = h.mail.emails.findLast(
    (candidate) => candidate.to === email && candidate.subject.includes("deleted"),
  );
  const match = /token=([A-Za-z0-9_-]+)/.exec(message?.text ?? "");
  if (match?.[1] === undefined) throw new Error(`no deletion email for ${email}`);
  return match[1];
}

/** Asks for a magic link and opens it; returns the verify response. */
async function openMagicLink(email: string) {
  await h.app.inject({
    method: "POST",
    url: "/auth/sign-in/magic-link",
    headers: { origin: APP_ORIGIN },
    payload: { email },
  });
  return h.app.inject({ method: "GET", url: magicLinkPath(h.mail.emails, email) });
}

async function userIdOf(email: string): Promise<string> {
  const [user] = await h.database.db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email));
  if (user === undefined) throw new Error(`no user ${email}`);
  return user.id;
}

/** A host with one listed charger, tax details and a connected account. */
async function hostWithCharger(db: Executor, userId: string) {
  const [host] = await db
    .insert(hosts)
    .values({ userId, payoutStatus: "enabled", stripeAccountId: `acct_${userId}` })
    .returning({ id: hosts.id });
  if (host === undefined) throw new Error("no host");
  const suffix = randomBytes(4).toString("hex");
  const [charger] = await db
    .insert(chargers)
    .values({
      hostId: host.id,
      model: "zappi_v2_1",
      serial: `2${suffix}`,
      chargeboxId: `del-${suffix}`,
      ocppAuthHash: "hash",
      hostIdTag: `H${suffix}`,
      firmware: "5.794",
      maxKw: 7.4,
      connectorType: "tethered",
      location: { lat: 53.32617, lng: -6.25694 },
      address: "7 Test Road, Dublin 6",
      status: "online",
      acceptingBookings: true,
    })
    .returning({ id: chargers.id });
  if (charger === undefined) throw new Error("no charger");
  await db.insert(hostTaxDetails).values({
    hostId: host.id,
    entityType: "individual",
    legalName: "Niamh Walsh",
    dateOfBirthEncrypted: "sealed",
    addressLine1: "7 Test Road",
    city: "Dublin",
    addressCountry: "IE",
    taxCountry: "IE",
    tinEncrypted: "sealed",
    tinMasked: "*****567T",
    encryptionKeyId: "test-1",
  });
  await db.update(hosts).set({ taxDetailsComplete: true }).where(eq(hosts.id, host.id));
  return { hostId: host.id, chargerId: charger.id };
}

let slotDay = 0;
/** A booking in `status`, paid upfront: `cents`, of which 1.5 % + 25 cents is the card fee. */
async function paidBooking(
  db: Executor,
  chargerId: string,
  driverId: string,
  cents: number,
  status: "completed" | "confirmed" = "completed",
) {
  slotDay += 1;
  const start = new Date(Date.UTC(2026, 0, slotDay, 22));
  const [booking] = await db
    .insert(bookings)
    .values({
      chargerId,
      driverId,
      slot: { start, end: new Date(start.getTime() + 8 * 3_600_000) },
      status,
      idTag: `T${randomBytes(9).toString("hex").toUpperCase()}`,
      quotedAmountCents: cents,
      vehiclePlate: "261-D-12345",
    })
    .returning({ id: bookings.id });
  if (booking === undefined) throw new Error("no booking");
  if (status !== "completed") return booking.id;
  await db.insert(sessions).values({ bookingId: booking.id, status: "reconciled" });
  const [payment] = await db
    .insert(payments)
    .values({
      bookingId: booking.id,
      amountCents: cents,
      cardFeeCents: Math.ceil((cents * 150) / 10_000) + 25,
      status: "paid",
    })
    .returning({ id: payments.id });
  if (payment === undefined) throw new Error("no payment");
  return booking.id;
}

/** What the host received: the paid bookings on their chargers, less the card fees. */
async function payoutSum(hostId: string): Promise<number> {
  const result = await h.database.db.execute<{ total: string | null }>(sql`
    select sum(p.amount_cents - p.card_fee_cents - p.platform_fee_cents) as total
      from payments p
      join bookings b on b.id = p.booking_id
      join chargers c on c.id = b.charger_id
     where c.host_id = ${hostId} and p.status = 'paid'`);
  return Number(result.rows[0]?.total ?? 0);
}

describe("POST /me/delete", () => {
  it("signs the user out everywhere at once and emails an undo link", async () => {
    const email = "aoife.delete@example.com";
    const first = await h.user(email);
    const second = await h.user(email);
    now = new Date();

    const response = await requestDeletion(first);
    expect(response.statusCode).toBe(202);
    const dueAt = new Date(response.json<{ deletionDueAt: string }>().deletionDueAt);
    expect(dueAt.getTime() - now.getTime()).toBe(DELETION_UNDO_DAYS * DAY_MS);

    expect((await me(first)).statusCode).toBe(401);
    expect((await me(second)).statusCode).toBe(401);
    expect(undoToken(email)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const sent = h.mail.emails.findLast((message) => message.to === email);
    expect(sent?.html).toContain("Keep my account");
  });

  it("refuses to sign anyone in to the account while it waits", async () => {
    const verified = await openMagicLink("aoife.delete@example.com");
    expect(verified.statusCode).toBe(403);
    expect(verified.json()).toMatchObject({ code: "ACCOUNT_DELETION_PENDING" });
    expect(String(verified.headers["set-cookie"] ?? "")).not.toContain("session_token=");
  });

  it("is undone by the emailed token within the window, once", async () => {
    const email = "aoife.delete@example.com";
    const token = undoToken(email);
    now = new Date(Date.now() + (DELETION_UNDO_DAYS - 1) * DAY_MS);
    expect((await undo(token)).statusCode).toBe(204);
    expect((await undo(token)).statusCode).toBe(404);
    now = new Date();

    const cookie = await h.user(email);
    expect((await me(cookie)).statusCode).toBe(200);
    expect(await processDueDeletions(h.database.db, new Date(Date.now() + 30 * DAY_MS))).toEqual(
      expect.objectContaining({ completed: 0 }),
    );
    expect((await me(cookie)).statusCode).toBe(200);
  });

  it("cannot be undone once the window has passed, or with a made-up token", async () => {
    const email = "sam.delete@example.com";
    const cookie = await h.user(email);
    now = new Date();
    expect((await requestDeletion(cookie)).statusCode).toBe(202);
    now = new Date(Date.now() + DELETION_UNDO_DAYS * DAY_MS + 1_000);
    const response = await undo(undoToken(email));
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "deletion-not-found" });
    expect((await undo("x".repeat(43))).statusCode).toBe(404);
    now = new Date();
  });

  it("is refused while the user has a booking that is not finished", async () => {
    const hostEmail = "cian.host@example.com";
    await h.user(hostEmail);
    const { chargerId } = await hostWithCharger(h.database.db, await userIdOf(hostEmail));
    const driverEmail = "orla.driver@example.com";
    const driver = await h.user(driverEmail);
    await paidBooking(h.database.db, chargerId, await userIdOf(driverEmail), 2000, "confirmed");

    const response = await requestDeletion(driver);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "account-deletion-blocked",
      reasons: [{ code: "open-booking" }],
    });
    expect((await me(driver)).statusCode).toBe(200);

    const host = await h.user(hostEmail);
    const refused = await requestDeletion(host);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ reasons: [{ code: "host-open-booking" }] });
  });

  it("is refused while a refund is still in flight", async () => {
    const hostEmail = "eoin.host@example.com";
    await h.user(hostEmail);
    const { chargerId } = await hostWithCharger(h.database.db, await userIdOf(hostEmail));
    const driverEmail = "ciara.driver@example.com";
    const driver = await h.user(driverEmail);
    const bookingId = await paidBooking(
      h.database.db,
      chargerId,
      await userIdOf(driverEmail),
      1500,
    );
    const [payment] = await h.database.db
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.bookingId, bookingId));
    await h.database.db.insert(refunds).values({
      paymentId: payment?.id ?? "",
      amountCents: 500,
      currency: "EUR",
      reason: "support",
    });
    const response = await requestDeletion(driver);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reasons: [{ code: "payment-in-flight" }] });
  });

  it("takes the host's chargers off the listings, and an undo puts them back", async () => {
    const email = "roisin.host@example.com";
    const cookie = await h.user(email);
    const { chargerId } = await hostWithCharger(h.database.db, await userIdOf(email));
    const listed = async () => {
      const [row] = await h.database.db
        .select({ accepting: chargers.acceptingBookings })
        .from(chargers)
        .where(eq(chargers.id, chargerId));
      return row?.accepting;
    };
    now = new Date();
    expect((await requestDeletion(cookie)).statusCode).toBe(202);
    expect(await listed()).toBe(false);
    expect((await undo(undoToken(email))).statusCode).toBe(204);
    expect(await listed()).toBe(true);
  });

  it("changes nothing when the confirmation email cannot be sent", async () => {
    const email = "fail.delete@example.com";
    const cookie = await h.user(email);
    const original = h.mail.email.send.bind(h.mail.email);
    h.mail.email.send = () => Promise.reject(new Error("provider down"));
    try {
      const response = await requestDeletion(cookie);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "email-unavailable" });
    } finally {
      h.mail.email.send = original;
    }
    expect((await me(cookie)).statusCode).toBe(200);
    expect((await requestDeletion(cookie)).statusCode).toBe(202);
  });

  it("needs a session", async () => {
    expect((await h.app.inject({ method: "POST", url: "/me/delete" })).statusCode).toBe(401);
  });
});

describe("processDueDeletions", () => {
  it("anonymises a host after the window, keeps their earnings adding up and their tax details for reporting", async () => {
    const email = "niamh.delete@example.com";
    const cookie = await h.user(email, "+353861119999");
    const userId = await userIdOf(email);
    const { hostId, chargerId } = await hostWithCharger(h.database.db, userId);
    const driverEmail = "padraig.driver@example.com";
    await h.user(driverEmail);
    const driverId = await userIdOf(driverEmail);
    await paidBooking(h.database.db, chargerId, driverId, 2400);
    await paidBooking(h.database.db, chargerId, driverId, 1850);
    await h.database.db
      .insert(deviceTokens)
      .values({ userId, platform: "ios", token: `push-${randomBytes(8).toString("hex")}` });
    await h.database.db.insert(authAccounts).values({
      id: `acc-${userId}`,
      userId,
      accountId: "google-123",
      providerId: "google",
    });
    const customer = await h.stripeMock.sdk.customers.create({ email, name: "Niamh" });
    await h.database.db
      .update(users)
      .set({ stripeCustomerId: customer.id })
      .where(eq(users.id, userId));
    const before = await payoutSum(hostId);
    // 2400 − 61 and 1850 − 53: each less its card fee.
    expect(before).toBe(4136);

    const requestedAt = new Date();
    now = requestedAt;
    expect((await requestDeletion(cookie)).statusCode).toBe(202);

    const early = await processDueDeletions(
      h.database.db,
      new Date(requestedAt.getTime() + (DELETION_UNDO_DAYS - 1) * DAY_MS),
    );
    expect(early.completed).toBe(0);
    const [stillThere] = await h.database.db.select().from(users).where(eq(users.id, userId));
    expect(stillThere?.email).toBe(email);

    const due = new Date(requestedAt.getTime() + DELETION_UNDO_DAYS * DAY_MS);
    const run = await processDueDeletions(h.database.db, due);
    expect(run.completed).toBeGreaterThanOrEqual(1);
    expect(run.skipped.map((skip) => skip.userId)).not.toContain(userId);

    const [user] = await h.database.db.select().from(users).where(eq(users.id, userId));
    expect(user).toMatchObject({
      name: "Deleted user",
      email: `deleted-${userId}@deleted.invalid`,
      phone: null,
      phoneVerified: false,
      image: null,
      stripeCustomerId: null,
      deletedAt: due,
    });
    expect(JSON.stringify(user)).not.toContain("niamh");
    expect(h.stripeMock.deletedCustomers).toContain(customer.id);
    // Paid bookings are reportable: the tax details stay, encrypted, for six years.
    const retainUntil = new Date(due);
    retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + 6);
    const taxRows = () =>
      h.database.db.select().from(hostTaxDetails).where(eq(hostTaxDetails.hostId, hostId));
    expect(await taxRows()).toMatchObject([{ retainUntil, tinEncrypted: "sealed" }]);
    await purgeExpiredTaxRecords(h.database.db, new Date(retainUntil.getTime() - 1));
    expect(await taxRows()).toHaveLength(1);
    await purgeExpiredTaxRecords(h.database.db, retainUntil);
    expect(await taxRows()).toEqual([]);
    expect(
      await h.database.db.select().from(deviceTokens).where(eq(deviceTokens.userId, userId)),
    ).toEqual([]);
    expect(
      await h.database.db.select().from(authAccounts).where(eq(authAccounts.userId, userId)),
    ).toEqual([]);
    const [host] = await h.database.db.select().from(hosts).where(eq(hosts.id, hostId));
    expect(host?.taxDetailsComplete).toBe(false);
    const [charger] = await h.database.db
      .select({
        address: chargers.address,
        location: chargers.location,
        accepting: chargers.acceptingBookings,
      })
      .from(chargers)
      .where(eq(chargers.id, chargerId));
    expect(charger).toMatchObject({ address: "", accepting: false });
    expect(charger?.location.lat).toBeCloseTo(53.3, 6);
    expect(charger?.location.lng).toBeCloseTo(-6.3, 6);
    const [deletion] = await h.database.db
      .select({ completedAt: accountDeletions.completedAt })
      .from(accountDeletions)
      .where(eq(accountDeletions.userId, userId));
    expect(deletion?.completedAt).toEqual(due);

    expect(await payoutSum(hostId)).toBe(before);
    expect((await me(cookie)).statusCode).toBe(401);

    // The address is free again: signing in with it makes a new, empty account.
    now = new Date();
    const fresh = await h.user(email);
    const profile = await me(fresh);
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toMatchObject({ email, isHost: false });
    expect(profile.json<{ id: string }>().id).not.toBe(userId);
  });

  it("removes a driver's plates and review comments but keeps their bookings", async () => {
    const hostEmail = "liam.host@example.com";
    await h.user(hostEmail);
    const hostUserId = await userIdOf(hostEmail);
    const { chargerId } = await hostWithCharger(h.database.db, hostUserId);
    const email = "aine.driver@example.com";
    const cookie = await h.user(email);
    const driverId = await userIdOf(email);
    const bookingId = await paidBooking(h.database.db, chargerId, driverId, 900);
    await h.database.db.insert(reviews).values({
      bookingId,
      reviewerId: driverId,
      revieweeId: hostUserId,
      rating: 5,
      comment: "Lovely, thanks Liam",
    });

    now = new Date();
    expect((await requestDeletion(cookie)).statusCode).toBe(202);
    await processDueDeletions(h.database.db, new Date(Date.now() + DELETION_UNDO_DAYS * DAY_MS));

    const [booking] = await h.database.db.select().from(bookings).where(eq(bookings.id, bookingId));
    expect(booking).toMatchObject({ driverId, vehiclePlate: null, quotedAmountCents: 900 });
    const [review] = await h.database.db
      .select()
      .from(reviews)
      .where(eq(reviews.bookingId, bookingId));
    expect(review).toMatchObject({ rating: 5, comment: null });
  });

  it("leaves a due request pending while something blocks it", async () => {
    const hostEmail = "maeve.host@example.com";
    await h.user(hostEmail);
    const { chargerId } = await hostWithCharger(h.database.db, await userIdOf(hostEmail));
    const email = "blocked.driver@example.com";
    await h.user(email);
    const userId = await userIdOf(email);
    const requestedAt = new Date();
    await h.database.db.insert(accountDeletions).values({
      userId,
      requestedAt,
      dueAt: new Date(requestedAt.getTime() + DAY_MS),
      undoTokenHash: hashUndoToken(randomBytes(32).toString("base64url")),
    });
    await paidBooking(h.database.db, chargerId, userId, 1000, "confirmed");

    const run = await processDueDeletions(
      h.database.db,
      new Date(requestedAt.getTime() + 2 * DAY_MS),
    );
    expect(run.skipped).toContainEqual({
      userId,
      blockers: [expect.objectContaining({ code: "open-booking" })],
    });
    const [user] = await h.database.db.select().from(users).where(eq(users.id, userId));
    expect(user?.email).toBe(email);
  });

  it("deletes the tax details of a host who was never paid", async () => {
    const email = "orla.host@example.com";
    const cookie = await h.user(email);
    const userId = await userIdOf(email);
    const { hostId } = await hostWithCharger(h.database.db, userId);
    now = new Date();
    expect((await requestDeletion(cookie)).statusCode).toBe(202);
    await processDueDeletions(h.database.db, new Date(Date.now() + DELETION_UNDO_DAYS * DAY_MS));
    expect(
      await h.database.db.select().from(hostTaxDetails).where(eq(hostTaxDetails.hostId, hostId)),
    ).toEqual([]);
  });
});
