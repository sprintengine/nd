import { hosts, hostTaxDetails, users } from "@nd/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { TEST_TAX_KEYS } from "../../test/config.ts";
import { type Harness, startHarness } from "../../test/harness.ts";
import { APP_ORIGIN } from "../../test/http.ts";
import { rotateTaxEncryptionKeys, sealContext } from "../data/tax-details.ts";
import { parseTaxKeyring, unseal } from "../tax/crypto.ts";

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

/** A signed-in user with a verified phone who has become a host. */
async function host(email: string, phone: string): Promise<{ cookie: string; hostId: string }> {
  const cookie = await h.user(email, phone);
  const created = await h.app.inject({
    method: "POST",
    url: "/hosts",
    headers: { cookie, origin: APP_ORIGIN },
    payload: {},
  });
  expect(created.statusCode).toBe(200);
  return { cookie, hostId: created.json<{ hostId: string }>().hostId };
}

const individual = {
  type: "individual",
  legalName: "Aoife Byrne",
  dateOfBirth: "1990-04-12",
  address: {
    line1: "1 Test Lane",
    city: "Dublin",
    region: "Co. Dublin",
    postalCode: "D06 X000",
    country: "ie",
  },
  taxCountry: "IE",
  tin: "1234567 fa",
};

const put = (cookie: string, payload: object) =>
  h.app.inject({ method: "PUT", url: "/hosts/me/tax-details", headers: { cookie }, payload });
const get = (cookie: string) =>
  h.app.inject({ method: "GET", url: "/hosts/me/tax-details", headers: { cookie } });

async function rawRow(hostId: string) {
  const [row] = await h.database.db
    .select()
    .from(hostTaxDetails)
    .where(eq(hostTaxDetails.hostId, hostId));
  if (row === undefined) throw new Error("no tax details row");
  return row;
}

describe("PUT /hosts/me/tax-details", () => {
  let aoife: { cookie: string; hostId: string };

  beforeAll(async () => {
    aoife = await host("aoife.tax@example.com", "+353861110001");
  });

  it("stores the TIN and date of birth encrypted and answers with them masked", async () => {
    const response = await put(aoife.cookie, individual);
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      type: "individual",
      legalName: "Aoife Byrne",
      dateOfBirthOnFile: true,
      companyName: null,
      address: { line1: "1 Test Lane", line2: null, country: "IE", postalCode: "D06 X000" },
      taxCountry: "IE",
      tinMasked: "******7FA",
      complete: true,
    });
    expect(response.body).not.toContain("1234567");
    expect(response.body).not.toContain("1990");

    const row = await rawRow(aoife.hostId);
    expect(row.tinEncrypted).not.toContain("1234567");
    expect(row.dateOfBirthEncrypted).not.toContain("1990");
    expect(row.encryptionKeyId).toBe("test-1");
    const keyring = parseTaxKeyring(TEST_TAX_KEYS);
    expect(
      unseal(
        keyring,
        { keyId: row.encryptionKeyId, ciphertext: row.tinEncrypted },
        sealContext("tin", aoife.hostId),
      ),
    ).toBe("1234567FA");
    expect(
      unseal(
        keyring,
        { keyId: row.encryptionKeyId, ciphertext: row.dateOfBirthEncrypted ?? "" },
        sealContext("date_of_birth", aoife.hostId),
      ),
    ).toBe("1990-04-12");

    const [flag] = await h.database.db
      .select({ complete: hosts.taxDetailsComplete })
      .from(hosts)
      .where(eq(hosts.id, aoife.hostId));
    expect(flag?.complete).toBe(true);
  });

  it("reads them back masked", async () => {
    const response = await get(aoife.cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tinMasked: "******7FA", dateOfBirthOnFile: true });
    expect(response.body).not.toMatch(/1234567|1990-04-12/);
    expect(response.json()).not.toHaveProperty("tin");
    expect(response.json()).not.toHaveProperty("dateOfBirth");
  });

  it.each([
    ["a PPSN with a wrong check letter", { tin: "1234567A" }, "body.tin"],
    ["a UK number for Ireland", { tin: "1234567890" }, "body.tin"],
    ["a UTR that is too short", { taxCountry: "GB", tin: "123456789" }, "body.tin"],
    ["a malformed NINO", { taxCountry: "GB", tin: "GB123456A" }, "body.tin"],
    ["an under-age host", { dateOfBirth: "2015-01-01" }, "body.dateOfBirth"],
    ["an impossible date", { dateOfBirth: "1990-02-31" }, "body.dateOfBirth"],
  ])("rejects %s", async (_reason, change, path) => {
    const response = await put(aoife.cookie, { ...individual, ...change });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid-request" });
    expect(response.json<{ errors: { path: string }[] }>().errors.map((e) => e.path)).toContain(
      path,
    );
    expect(response.body).not.toContain("1234567");
    const row = await rawRow(aoife.hostId);
    expect(row.tinMasked).toBe("******7FA");
  });

  it("accepts a UK business with a UTR and replaces the earlier details", async () => {
    const response = await put(aoife.cookie, {
      type: "business",
      companyName: "Byrne Charging Ltd",
      companyNumber: "sc123456",
      address: { line1: "2 Test Street", city: "Belfast", country: "GB" },
      taxCountry: "GB",
      tin: "12345 67890",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      type: "business",
      legalName: null,
      dateOfBirthOnFile: false,
      companyNumber: "SC123456",
      tinMasked: "*******890",
    });
    const row = await rawRow(aoife.hostId);
    expect(row.dateOfBirthEncrypted).toBeNull();
    expect(row.legalName).toBeNull();
  });

  it("rejects a company number that fits neither register", async () => {
    const response = await put(aoife.cookie, {
      type: "business",
      companyName: "Byrne Charging Ltd",
      companyNumber: "1234567",
      address: { line1: "2 Test Street", city: "Dublin", country: "IE" },
      taxCountry: "IE",
      tin: "1234567T",
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("body.companyNumber");
  });

  it("restores the individual details for the next tests", async () => {
    expect((await put(aoife.cookie, individual)).statusCode).toBe(200);
  });
});

describe("access", () => {
  it("never shows one host's details to another", async () => {
    const cian = await host("cian.tax@example.com", "+353861110002");
    const response = await get(cian.cookie);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "tax-details-not-found" });
    expect(response.body).not.toContain("7FA");
  });

  it("needs a host profile and a session", async () => {
    const cookie = await h.user("orla.tax@example.com", "+353861110003");
    expect((await get(cookie)).statusCode).toBe(403);
    expect((await put(cookie, individual)).statusCode).toBe(403);
    expect((await h.app.inject({ method: "GET", url: "/hosts/me/tax-details" })).statusCode).toBe(
      401,
    );
  });
});

describe("rotateTaxEncryptionKeys", () => {
  it("re-encrypts rows on an old key with the current one", async () => {
    const [user] = await h.database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "aoife.tax@example.com"));
    const [aoifeHost] = await h.database.db
      .select({ id: hosts.id })
      .from(hosts)
      .where(eq(hosts.userId, user?.id ?? ""));
    const hostId = aoifeHost?.id ?? "";
    const before = await rawRow(hostId);

    const rotated = parseTaxKeyring(
      `test-2:${Buffer.alloc(32, 8).toString("base64")},${TEST_TAX_KEYS}`,
    );
    expect(await rotateTaxEncryptionKeys(h.database.db, rotated)).toBeGreaterThanOrEqual(1);
    expect(await rotateTaxEncryptionKeys(h.database.db, rotated)).toBe(0);

    const after = await rawRow(hostId);
    expect(after.encryptionKeyId).toBe("test-2");
    expect(after.tinEncrypted).not.toBe(before.tinEncrypted);
    const retired = parseTaxKeyring(`test-2:${Buffer.alloc(32, 8).toString("base64")}`);
    expect(
      unseal(
        retired,
        { keyId: after.encryptionKeyId, ciphertext: after.tinEncrypted },
        sealContext("tin", hostId),
      ),
    ).toBe("1234567FA");
    expect(
      unseal(
        retired,
        { keyId: after.encryptionKeyId, ciphertext: after.dateOfBirthEncrypted ?? "" },
        sealContext("date_of_birth", hostId),
      ),
    ).toBe("1990-04-12");
  });
});
