import { describe, expect, it } from "vitest";

import { createMessageCapture } from "./capture.ts";

describe("message capture", () => {
  it("keeps emails and text messages, oldest first, and filters by recipient", async () => {
    const capture = createMessageCapture({ now: () => new Date("2027-01-11T12:00:00Z") });
    await capture.email.send({ to: "dev@example.com", subject: "Sign in", text: "link" });
    await capture.sms.send({ to: "+353861234567", body: "code 123456" });
    await capture.email.send({ to: "aoife@example.com", subject: "Other", text: "other" });

    expect(capture.list("dev@example.com")).toEqual([
      {
        channel: "email",
        to: "dev@example.com",
        subject: "Sign in",
        text: "link",
        sentAt: "2027-01-11T12:00:00.000Z",
      },
    ]);
    expect(capture.list("+353861234567")).toEqual([
      expect.objectContaining({ channel: "sms", subject: null, text: "code 123456" }),
    ]);
    expect(capture.list().map((message) => message.to)).toEqual([
      "dev@example.com",
      "+353861234567",
      "aoife@example.com",
    ]);
  });

  it("drops the oldest messages beyond its limit", async () => {
    const capture = createMessageCapture({ limit: 2 });
    for (const text of ["one", "two", "three"]) {
      await capture.sms.send({ to: "+353861234567", body: text });
    }
    expect(capture.list().map((message) => message.text)).toEqual(["two", "three"]);
  });
});
