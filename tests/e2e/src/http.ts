import { API_URL, APP_ORIGIN } from "./config.ts";

/** A response: status, parsed JSON body (or text) and headers. */
export interface Reply<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

/** An unexpected status from the API, with the body (problem+json) in the message. */
export class UnexpectedStatus extends Error {
  override readonly name = "UnexpectedStatus";
  readonly reply: Reply;

  constructor(request: string, reply: Reply) {
    super(`${request} -> ${String(reply.status)}: ${JSON.stringify(reply.body)}`);
    this.reply = reply;
  }
}

async function bodyOf(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * One person using the API, as the app would: a cookie jar holding the
 * session, and the web app's Origin on every request.
 */
export class ApiClient {
  #cookies = new Map<string, string>();

  readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  /** The Cookie header this client sends. */
  get cookie(): string {
    return [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  /** Sends a request and returns whatever came back. Redirects are not followed. */
  async send<T = unknown>(method: string, path: string, body?: unknown): Promise<Reply<T>> {
    const headers: Record<string, string> = { origin: APP_ORIGIN };
    if (this.#cookies.size > 0) headers.cookie = this.cookie;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      redirect: "manual",
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";")[0] ?? "";
      const at = pair.indexOf("=");
      if (at <= 0) continue;
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      if (value === "") this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
    return {
      status: response.status,
      body: (await bodyOf(response)) as T,
      headers: response.headers,
    };
  }

  /** Sends a request and returns the body; any status other than `status` fails the test. */
  async expect<T>(status: number, method: string, path: string, body?: unknown): Promise<T> {
    const reply = await this.send<T>(method, path, body);
    if (reply.status !== status)
      throw new UnexpectedStatus(`${this.label}: ${method} ${path}`, reply);
    return reply.body;
  }

  get<T>(path: string): Promise<T> {
    return this.expect<T>(200, "GET", path);
  }

  post<T>(path: string, body?: unknown, status = 200): Promise<T> {
    return this.expect<T>(status, "POST", path, body);
  }
}

/** A problem+json body's `type`, which ends in the problem's code. */
export function problemCode(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { type, code } = body as { type?: unknown; code?: unknown };
  if (typeof code === "string") return code;
  return typeof type === "string" ? type.split("/").pop() : undefined;
}
