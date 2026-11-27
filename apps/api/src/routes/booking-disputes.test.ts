import type * as NdDb from "@nd/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BOOKING_ID, bookingDetail, CHARGER_ID } from "../../test/booking-detail.ts";
import { scriptedChargerControl } from "../../test/fakes.ts";
import { SESSION_COOKIE, signInAs, startUnitApp, USER_ID } from "../../test/unit-app.ts";
import * as bookingData from "../data/bookings.ts";
import * as disputeData from "../data/disputes.ts";
import * as hostData from "../data/hosts.ts";

vi.mock("../data/bookings.ts");
vi.mock("../data/disputes.ts");
vi.mock("../data/hosts.ts");
vi.mock("@nd/db", async (importOriginal) => ({
  ...(await importOriginal<typeof NdDb>()),
  openTransactionForCharger: vi.fn(),
}));

const { openTransactionForCharger } = await import("@nd/db");

const DISPUTE_ID = "55555555-5555-4555-8555-555555555555";

let app: FastifyInstance;
let control: ReturnType<typeof scriptedChargerControl>;

const post = (url: string, payload?: object) =>
  app.inject({
    method: "POST",
    url,
    headers: SESSION_COOKIE,
    ...(payload === undefined ? {} : { payload }),
  });

beforeEach(() => {
  control = scriptedChargerControl();
  ({ app } = startUnitApp({}, { chargerControl: control.control }));
  signInAs(app);
});

afterEach(async () => {
  await app.close();
  vi.resetAllMocks();
});

describe("POST /bookings/:id/dispute", () => {
  const url = `/bookings/${BOOKING_ID}/dispute`;
  const body = { reason: "Charged for a session that never started", details: " No power. " };

  it("records the driver's dispute on a finished booking, once", async () => {
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(
      bookingDetail(USER_ID, { booking: { status: "completed" } }),
    );
    vi.mocked(disputeData.insertDisputeOnce)
      .mockResolvedValueOnce(DISPUTE_ID)
      .mockResolvedValueOnce(undefined);
    const first = await post(url, body);
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json()).toEqual({ bookingId: BOOKING_ID, disputeId: DISPUTE_ID });
    expect(disputeData.insertDisputeOnce).toHaveBeenCalledWith(expect.anything(), {
      bookingId: BOOKING_ID,
      raisedById: USER_ID,
      reason: body.reason,
      details: "No power.",
    });
    expect((await post(url, body)).json()).toMatchObject({
      status: 409,
      code: "already-disputed",
    });
  });

  it("is only for the booking's driver, once it has finished", async () => {
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(
      bookingDetail("user-cian", { host: { userId: USER_ID }, booking: { status: "completed" } }),
    );
    expect((await post(url, body)).json()).toMatchObject({ status: 403, code: "driver-only" });
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(
      bookingDetail("user-cian", { booking: { status: "completed" } }),
    );
    expect((await post(url, body)).json()).toMatchObject({ status: 404 });
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(undefined);
    expect((await post(url, body)).statusCode).toBe(404);
    vi.mocked(bookingData.findBookingDetail).mockResolvedValue(bookingDetail(USER_ID));
    expect((await post(url, body)).json()).toMatchObject({
      status: 409,
      code: "booking-not-finished",
    });
    expect((await post(url, { reason: "" })).statusCode).toBe(400);
    expect(disputeData.insertDisputeOnce).not.toHaveBeenCalled();
  });
});

describe("POST /hosts/chargers/:id/stop", () => {
  const url = `/hosts/chargers/${CHARGER_ID}/stop`;
  const owned = { id: CHARGER_ID, chargeboxId: "NDABCDEFGHJK" } as hostData.OwnedCharger;
  const charging = {
    session: { ocppTransactionId: 42 },
    booking: { id: BOOKING_ID },
  } as NdDb.OpenTransaction;

  it("sends the charger's host's stop for the session charging on it", async () => {
    vi.mocked(hostData.findOwnedCharger).mockResolvedValue(owned);
    vi.mocked(openTransactionForCharger).mockResolvedValue(charging);
    const response = await post(url);
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toEqual({ chargerId: CHARGER_ID, bookingId: BOOKING_ID });
    expect(hostData.findOwnedCharger).toHaveBeenCalledWith(expect.anything(), USER_ID, CHARGER_ID);
    expect(control.callsTo("remoteStop")).toEqual([
      { chargeboxId: "NDABCDEFGHJK", transactionId: 42 },
    ]);
  });

  it("is 404 for anyone but the charger's host", async () => {
    vi.mocked(hostData.findOwnedCharger).mockResolvedValue(undefined);
    vi.mocked(openTransactionForCharger).mockResolvedValue(charging);
    expect((await post(url)).json()).toMatchObject({ status: 404, code: "charger-not-found" });
    expect(control.calls).toEqual([]);
  });

  it("is 409 with nothing charging, and maps the charger's answer", async () => {
    vi.mocked(hostData.findOwnedCharger).mockResolvedValue(owned);
    vi.mocked(openTransactionForCharger).mockResolvedValue(undefined);
    expect((await post(url)).json()).toMatchObject({ status: 409, code: "nothing-charging" });
    vi.mocked(openTransactionForCharger).mockResolvedValue({
      ...charging,
      session: { ocppTransactionId: null },
    } as NdDb.OpenTransaction);
    expect((await post(url)).json()).toMatchObject({ status: 409, code: "nothing-charging" });

    vi.mocked(openTransactionForCharger).mockResolvedValue(charging);
    control.answer(
      "remoteStop",
      { ok: true, response: { status: "Rejected" } },
      { ok: false, reason: "offline", message: "not connected" },
    );
    expect((await post(url)).json()).toMatchObject({ status: 409, code: "stop-rejected" });
    expect((await post(url)).json()).toMatchObject({ status: 503, code: "charger-unreachable" });
  });
});
