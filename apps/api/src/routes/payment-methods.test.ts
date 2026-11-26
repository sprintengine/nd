import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { fakePayments } from "../../test/fakes.ts";
import { SESSION_COOKIE, signInAs, startUnitApp, USER_ID } from "../../test/unit-app.ts";
import * as data from "../data/bookings.ts";

vi.mock("../data/bookings.ts");

let app: FastifyInstance;
let payments: ReturnType<typeof fakePayments>;

const customer = (stripeCustomerId: string | null) => ({
  id: USER_ID,
  name: "Aoife Byrne",
  email: "aoife@example.com",
  stripeCustomerId,
});

const send = (method: "GET" | "POST", url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: SESSION_COOKIE,
    ...(payload === undefined ? {} : { payload }),
  });

beforeEach(() => {
  ({ app, payments } = startUnitApp());
  signInAs(app, { phoneVerified: false });
  vi.mocked(data.findCustomer).mockResolvedValue(customer("cus_1"));
});

afterEach(async () => {
  await app.close();
  vi.resetAllMocks();
});

describe("POST /me/payment-methods/setup-intent", () => {
  it("creates the customer on first use and returns a client secret", async () => {
    vi.mocked(data.findCustomer).mockResolvedValue(customer(null));
    vi.mocked(data.saveCustomerId).mockResolvedValue(`cus_${USER_ID}`);
    const response = await send("POST", "/me/payment-methods/setup-intent");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({ setupIntentId: "seti_1", clientSecret: "seti_1_secret_x" });
    expect(payments.callsTo("createCustomer")[0]?.input).toEqual({
      userId: USER_ID,
      email: "aoife@example.com",
      name: "Aoife Byrne",
    });
    expect(payments.callsTo("createSetupIntent")[0]?.input).toMatchObject({
      customerId: `cus_${USER_ID}`,
    });
  });

  it("reuses the customer", async () => {
    await send("POST", "/me/payment-methods/setup-intent");
    expect(payments.callsTo("createCustomer")).toHaveLength(0);
  });

  it("is 401 for a user who has gone", async () => {
    vi.mocked(data.findCustomer).mockResolvedValue(undefined);
    expect((await send("POST", "/me/payment-methods/setup-intent")).statusCode).toBe(401);
  });

  it("needs a session", async () => {
    vi.restoreAllMocks();
    const response = await app.inject({ method: "POST", url: "/me/payment-methods/setup-intent" });
    expect(response.statusCode).toBe(401);
  });
});

describe("GET /me/payment-methods", () => {
  it("lists cards and marks the default", async () => {
    const response = await send("GET", "/me/payment-methods");
    expect(response.json()).toEqual({
      cards: [
        {
          id: "pm_card_visa",
          brand: "visa",
          last4: "4242",
          expMonth: 12,
          expYear: 2030,
          isDefault: true,
        },
      ],
      defaultPaymentMethodId: "pm_card_visa",
    });
  });

  it("is empty without a customer", async () => {
    vi.mocked(data.findCustomer).mockResolvedValue(customer(null));
    expect((await send("GET", "/me/payment-methods")).json()).toEqual({
      cards: [],
      defaultPaymentMethodId: null,
    });
    expect(payments.calls).toHaveLength(0);
  });
});

describe("POST /me/payment-methods/default", () => {
  it("sets one of the user's cards as the default", async () => {
    payments.state.defaultCardId = null;
    const response = await send("POST", "/me/payment-methods/default", {
      paymentMethodId: "pm_card_visa",
    });
    expect(response.json()).toMatchObject({ defaultPaymentMethodId: "pm_card_visa" });
  });

  it("is 404 for a card that is not the user's", async () => {
    const response = await send("POST", "/me/payment-methods/default", {
      paymentMethodId: "pm_other",
    });
    expect(response.statusCode).toBe(404);
    vi.mocked(data.findCustomer).mockResolvedValue(customer(null));
    expect(
      (await send("POST", "/me/payment-methods/default", { paymentMethodId: "pm_card_visa" }))
        .statusCode,
    ).toBe(404);
    expect(
      (await send("POST", "/me/payment-methods/default", { paymentMethodId: "card" })).statusCode,
    ).toBe(400);
  });
});
