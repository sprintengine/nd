import { describe, expect, it } from "vitest";

import { bearerMatches, chargeboxIdFromPath, parseBasicAuth } from "./http-auth.ts";

const basic = (value: string) => `Basic ${Buffer.from(value).toString("base64")}`;

describe("chargeboxIdFromPath", () => {
  it.each([
    ["/v16/21234567", "21234567"],
    ["/v16/21234567?x=1", "21234567"],
    ["/v16/ZAPPI%2D01", "ZAPPI-01"],
  ])("reads %s", (path, id) => {
    expect(chargeboxIdFromPath(path)).toBe(id);
  });

  it.each([
    undefined,
    "/",
    "/v16/",
    "/v16/a/b",
    "/v201/21234567",
    "/v16/%E0%A4%A",
    "/v16/a%20b",
    `/v16/${"x".repeat(65)}`,
  ])("refuses %s", (path) => {
    expect(chargeboxIdFromPath(path)).toBeUndefined();
  });
});

describe("parseBasicAuth", () => {
  it("splits at the first colon", () => {
    expect(parseBasicAuth(basic("21234567:pa:ss"))).toEqual({
      username: "21234567",
      password: "pa:ss",
    });
    expect(parseBasicAuth(`basic ${Buffer.from("a:").toString("base64")}`)).toEqual({
      username: "a",
      password: "",
    });
  });

  it.each([undefined, "", "Bearer abc", basic("no-colon"), basic(":only-password"), "Basic !!!"])(
    "refuses %s",
    (header) => {
      expect(parseBasicAuth(header)).toBeUndefined();
    },
  );
});

describe("bearerMatches", () => {
  const secret = "s".repeat(40);

  it("accepts the secret", () => {
    expect(bearerMatches(`Bearer ${secret}`, secret)).toBe(true);
  });

  it.each([undefined, "", secret, `Bearer ${secret}x`, `Basic ${secret}`, "Bearer "])(
    "refuses %s",
    (header) => {
      expect(bearerMatches(header, secret)).toBe(false);
    },
  );
});
