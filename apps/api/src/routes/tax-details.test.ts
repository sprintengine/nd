import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NOW, SESSION_COOKIE, signInAs, startUnitApp, USER_ID } from "../../test/unit-app.ts";
import * as hostData from "../data/hosts.ts";
import * as taxData from "../data/tax-details.ts";

vi.mock("../data/hosts.ts");
vi.mock("../data/tax-details.ts");

const HOST_ID = "33333333-3333-4333-8333-333333333333";
const host = { id: HOST_ID, userId: USER_ID } as unknown as Awaited<
  ReturnType<typeof hostData.findHost>
>;

const stored: taxData.StoredTaxDetails = {
  entityType: "individual",
  legalName: "Aoife Byrne",
  companyName: null,
  companyNumber: null,
  addressLine1: "1 Test Lane",
  addressLine2: null,
  city: "Dublin",
  region: null,
  postalCode: null,
  addressCountry: "IE",
  taxCountry: "IE",
  tinMasked: "*****567T",
  updatedAt: NOW,
};

const individual = {
  type: "individual",
  legalName: "Aoife Byrne",
  dateOfBirth: "1990-04-12",
  address: { line1: "1 Test Lane", city: "Dublin", country: "IE" },
  taxCountry: "IE",
  tin: "1234567T",
};

let app: FastifyInstance;

const put = (payload: object) =>
  app.inject({ method: "PUT", url: "/hosts/me/tax-details", headers: SESSION_COOKIE, payload });
const get = () =>
  app.inject({ method: "GET", url: "/hosts/me/tax-details", headers: SESSION_COOKIE });

beforeEach(() => {
  app = startUnitApp().app;
  signInAs(app);
  vi.mocked(hostData.findHost).mockResolvedValue(host);
  vi.mocked(taxData.findTaxDetails).mockResolvedValue(stored);
  vi.mocked(taxData.saveTaxDetails).mockResolvedValue();
});

afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  vi.mocked(hostData.findHost).mockReset();
  vi.mocked(taxData.findTaxDetails).mockReset();
  vi.mocked(taxData.saveTaxDetails).mockReset();
});

describe("GET /hosts/me/tax-details", () => {
  it("shows the masked details", async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      type: "individual",
      dateOfBirthOnFile: true,
      tinMasked: "*****567T",
      complete: true,
      updatedAt: NOW.toISOString(),
    });
  });

  it("is 404 before any are saved and 403 for a non-host", async () => {
    vi.mocked(taxData.findTaxDetails).mockResolvedValueOnce(undefined);
    expect((await get()).json()).toMatchObject({ status: 404, code: "tax-details-not-found" });
    vi.mocked(hostData.findHost).mockResolvedValueOnce(undefined);
    expect((await get()).json()).toMatchObject({ status: 403, code: "host-required" });
  });

  it("needs a verified phone", async () => {
    signInAs(app, { phoneVerified: false });
    expect((await get()).statusCode).toBe(403);
  });
});

describe("PUT /hosts/me/tax-details", () => {
  it("normalizes and saves an individual's details", async () => {
    const response = await put({
      ...individual,
      tin: "1234567 t",
      address: { ...individual.address, country: "ie" },
    });
    expect(response.statusCode).toBe(200);
    expect(taxData.saveTaxDetails).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ currentId: "test-1" }),
      HOST_ID,
      expect.objectContaining({
        entityType: "individual",
        legalName: "Aoife Byrne",
        dateOfBirth: "1990-04-12",
        companyName: null,
        addressCountry: "IE",
        addressLine2: null,
        tin: "1234567T",
        tinMasked: "*****67T",
      }),
    );
  });

  it("normalizes a business's company number", async () => {
    vi.mocked(taxData.findTaxDetails).mockResolvedValueOnce({
      ...stored,
      entityType: "business",
      legalName: null,
      companyName: "Byrne Charging Ltd",
      companyNumber: "SC123456",
      taxCountry: "GB",
    });
    const response = await put({
      type: "business",
      companyName: "Byrne Charging Ltd",
      companyNumber: "sc 123456",
      address: {
        line1: "2 Test Street",
        line2: "Unit 4",
        city: "Belfast",
        region: "Antrim",
        postalCode: "BT1 1AA",
        country: "GB",
      },
      taxCountry: "GB",
      tin: "AB123456C",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ type: "business", dateOfBirthOnFile: false });
    expect(taxData.saveTaxDetails).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      HOST_ID,
      expect.objectContaining({
        companyNumber: "SC123456",
        dateOfBirth: null,
        legalName: null,
        tin: "AB123456C",
        region: "Antrim",
      }),
    );
  });

  it.each([
    ["a bad PPSN", { tin: "1234567A" }, "body.tin"],
    ["a bad UK number", { taxCountry: "GB", tin: "12345" }, "body.tin"],
    ["a minor", { dateOfBirth: "2010-01-01" }, "body.dateOfBirth"],
    ["a 121-year-old", { dateOfBirth: "1905-01-01" }, "body.dateOfBirth"],
    ["a date that does not exist", { dateOfBirth: "1990-02-30" }, "body.dateOfBirth"],
    [
      "a bad country",
      { address: { line1: "x", city: "y", country: "Ireland" } },
      "body.address.country",
    ],
  ])("rejects %s", async (_reason, change, path) => {
    const response = await put({ ...individual, ...change });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ errors: { path: string }[] }>().errors.map((e) => e.path)).toContain(
      path,
    );
    expect(taxData.saveTaxDetails).not.toHaveBeenCalled();
  });

  it("accepts someone whose 18th birthday is today", async () => {
    const response = await put({ ...individual, dateOfBirth: "2009-01-11" });
    expect(response.statusCode).toBe(200);
  });

  it("rejects someone turning 18 tomorrow", async () => {
    const response = await put({ ...individual, dateOfBirth: "2009-01-12" });
    expect(response.statusCode).toBe(400);
  });

  it("rejects a bad company number for each register", async () => {
    for (const taxCountry of ["IE", "GB"]) {
      const response = await put({
        type: "business",
        companyName: "Byrne Charging Ltd",
        companyNumber: "12345678901",
        address: individual.address,
        taxCountry,
        tin: taxCountry === "IE" ? "1234567T" : "1234567890",
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).toContain(
        taxCountry === "IE" ? "Registration Office" : "Companies House",
      );
    }
  });

  it("is 503 without an encryption key", async () => {
    await app.close();
    app = startUnitApp({ taxKeys: undefined }).app;
    signInAs(app);
    const response = await put(individual);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "tax-details-unavailable" });
  });

  it("is 404 if the saved row cannot be read back", async () => {
    vi.mocked(taxData.findTaxDetails).mockResolvedValueOnce(undefined);
    expect((await put(individual)).statusCode).toBe(404);
  });
});
