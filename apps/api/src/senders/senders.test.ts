import { describe, expect, it } from "vitest";

import { consoleEmailSender, consoleSmsSender } from "./senders.ts";

describe("console senders", () => {
  it("write the whole message in development", async () => {
    const lines: string[] = [];
    await consoleEmailSender({ sink: (line) => lines.push(line) }).send({
      to: "dev@example.com",
      subject: "Your sign-in link",
      text: "https://api.example.com/auth/magic-link/verify?token=abc",
    });
    await consoleSmsSender({ sink: (line) => lines.push(line) }).send({
      to: "+353860000000",
      body: "Code 123456",
    });
    expect(lines[0]).toContain("dev@example.com");
    expect(lines[0]).toContain("token=abc");
    expect(lines[1]).toContain("123456");
  });

  it("never write content or recipients when redacting", async () => {
    const lines: string[] = [];
    await consoleEmailSender({ redact: true, sink: (line) => lines.push(line) }).send({
      to: "dev@example.com",
      subject: "Your sign-in link",
      text: "token=abc",
    });
    await consoleSmsSender({ redact: true, sink: (line) => lines.push(line) }).send({
      to: "+353860000000",
      body: "Code 123456",
    });
    expect(lines.join("\n")).not.toMatch(/dev@example.com|token=abc|\+353|123456/);
    expect(lines).toHaveLength(2);
  });

  it("write to the console by default", async () => {
    await expect(
      consoleEmailSender().send({ to: "dev@example.com", subject: "s", text: "t" }),
    ).resolves.toBeUndefined();
    await expect(
      consoleSmsSender().send({ to: "+353860000000", body: "b" }),
    ).resolves.toBeUndefined();
  });
});
