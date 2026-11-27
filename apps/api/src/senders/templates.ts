// The messages the API sends. Every email has a plain-text part and a simple
// HTML part with the same content: no images, remote resources, scripts or
// tracking of any kind. Links appear in full in the text part.

export interface EmailContent {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for HTML element content and attribute values. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

interface HtmlEmail {
  readonly title: string;
  readonly paragraphs: readonly string[];
  readonly button: { readonly label: string; readonly url: string };
  readonly footer: string;
}

function htmlEmail({ title, paragraphs, button, footer }: HtmlEmail): string {
  const url = escapeHtml(button.url);
  const text = (value: string) =>
    `<p style="margin:0 0 16px;font-size:16px;line-height:24px">${escapeHtml(value)}</p>`;
  return [
    "<!doctype html>",
    '<html lang="en">',
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width">',
    `<title>${escapeHtml(title)}</title></head>`,
    "<body style=\"margin:0;padding:24px;background:#ffffff;color:#111111;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif\">",
    '<div style="max-width:480px;margin:0 auto">',
    `<h1 style="margin:0 0 16px;font-size:20px;line-height:28px">${escapeHtml(title)}</h1>`,
    ...paragraphs.map(text),
    `<p style="margin:24px 0"><a href="${url}" style="display:inline-block;padding:12px 20px;background:#111111;color:#ffffff;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(button.label)}</a></p>`,
    `<p style="margin:0 0 16px;font-size:14px;line-height:20px;color:#555555">If the button does not work, copy this link into your browser:<br><a href="${url}" style="color:#555555;word-break:break-all">${url}</a></p>`,
    `<p style="margin:24px 0 0;font-size:14px;line-height:20px;color:#555555">${escapeHtml(footer)}</p>`,
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
}

/** The sign-in email with a magic link. */
export function magicLinkEmail({
  url,
  expiresInMinutes,
}: {
  url: string;
  expiresInMinutes: number;
}): EmailContent {
  const validity = `It works once and expires in ${String(expiresInMinutes)} minutes.`;
  const footer =
    "If you did not ask to sign in, ignore this email. Nobody can sign in without the link.";
  return {
    subject: "Your sign-in link",
    text: `Sign in with this link. ${validity}\n\n${url}\n\n${footer}\n`,
    html: htmlEmail({
      title: "Sign in",
      paragraphs: [`Use the button below to sign in. ${validity}`],
      button: { label: "Sign in", url },
      footer,
    }),
  };
}

/** The text message with a phone verification code. */
export function phoneCodeSms({
  code,
  expiresInMinutes,
}: {
  code: string;
  expiresInMinutes: number;
}): string {
  return `Your verification code is ${code}. It expires in ${String(expiresInMinutes)} minutes. Never share it with anyone.`;
}

const dayFormat = new Intl.DateTimeFormat("en-IE", {
  dateStyle: "full",
  timeStyle: "short",
  timeZone: "UTC",
});

/** The confirmation that an account will be deleted, with the link to keep it. */
export function deletionScheduledEmail({
  undoUrl,
  dueAt,
}: {
  undoUrl: string;
  dueAt: Date;
}): EmailContent {
  const when = `${dayFormat.format(dueAt)} UTC`;
  const intro = `Your account will be deleted on ${when}. You have been signed out everywhere.`;
  const keep = "Changed your mind? Use this link before then to keep your account:";
  const footer =
    "After that date your personal details are removed for good. Records of past bookings and payments are kept without your name, as accounting rules require.";
  return {
    subject: "Your account will be deleted",
    text: `${intro}\n\n${keep}\n\n${undoUrl}\n\n${footer}\n`,
    html: htmlEmail({
      title: "Your account will be deleted",
      paragraphs: [intro, keep],
      button: { label: "Keep my account", url: undoUrl },
      footer,
    }),
  };
}
