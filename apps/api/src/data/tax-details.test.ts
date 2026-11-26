import { describe, expect, it } from "vitest";

import { sealContext } from "./tax-details.ts";

describe("sealContext", () => {
  it("binds a value to its column and host", () => {
    expect(sealContext("tin", "host-1")).toBe("host_tax_details.tin_encrypted:host-1");
    expect(sealContext("date_of_birth", "host-1")).not.toBe(sealContext("date_of_birth", "host-2"));
  });
});
