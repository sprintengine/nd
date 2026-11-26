import { describe, expect, it } from "vitest";

import { deletionScheduledEmail, escapeHtml, magicLinkEmail, phoneCodeSms } from "./templates.ts";

const LINK = "https://api.example.com/auth/magic-link/verify?token=abc&callbackURL=%2F";

describe("magicLinkEmail", () => {
  const email = magicLinkEmail({ url: LINK, expiresInMinutes: 15 });

  it("puts the whole link in the text part", () => {
    expect(email.subject).toBe("Your sign-in link");
    expect(email.text).toContain(LINK);
    expect(email.text).toContain("15 minutes");
  });

  it("escapes the link in the HTML part", () => {
    expect(email.html).toContain(`href="${LINK.replace("&", "&amp;")}"`);
    expect(email.html).not.toContain("token=abc&callbackURL");
  });

  it("loads nothing remote and tracks nothing", () => {
    expect(email.html).not.toMatch(/<img|<script|<link|url\(|@import|src=/i);
    const hrefs = [...email.html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
    expect(new Set(hrefs)).toEqual(new Set([LINK.replace("&", "&amp;")]));
  });
});

describe("phoneCodeSms", () => {
  it("states the code and how long it lasts", () => {
    expect(phoneCodeSms({ code: "123456", expiresInMinutes: 5 })).toBe(
      "Your verification code is 123456. It expires in 5 minutes. Never share it with anyone.",
    );
  });
});

describe("deletionScheduledEmail", () => {
  it("gives the date and the undo link", () => {
    const email = deletionScheduledEmail({
      undoUrl: "https://app.example.com/account/restore?token=t<1>",
      dueAt: new Date("2027-01-18T12:00:00Z"),
    });
    expect(email.text).toContain("18 January 2027");
    expect(email.text).toContain("https://app.example.com/account/restore?token=t<1>");
    expect(email.html).toContain("token=t&lt;1&gt;");
    expect(email.html).not.toContain("t<1>");
  });
});

describe("escapeHtml", () => {
  it("escapes markup and quotes", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
    );
  });
});
