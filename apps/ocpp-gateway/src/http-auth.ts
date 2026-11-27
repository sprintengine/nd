import { createHash, timingSafeEqual } from "node:crypto";

/** Longest ChargeboxID the gateway accepts in the URL. */
export const MAX_CHARGEBOX_ID_LENGTH = 64;

/** The ChargeboxID in an OCPP 1.6 upgrade path, `/v16/<ChargeboxID>`. */
export function chargeboxIdFromPath(url: string | undefined): string | undefined {
  const path = (url ?? "").split("?", 1)[0] ?? "";
  const match = /^\/v16\/([^/]+)$/.exec(path);
  if (match?.[1] === undefined) {
    return undefined;
  }
  let id: string;
  try {
    id = decodeURIComponent(match[1]);
  } catch {
    return undefined;
  }
  return id.length > 0 && id.length <= MAX_CHARGEBOX_ID_LENGTH && !/[\s/]/.test(id)
    ? id
    : undefined;
}

export interface BasicCredentials {
  readonly username: string;
  readonly password: string;
}

/** Reads an `Authorization: Basic ...` header. */
export function parseBasicAuth(header: string | undefined): BasicCredentials | undefined {
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? "");
  if (match?.[1] === undefined) {
    return undefined;
  }
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon <= 0) {
    return undefined;
  }
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/**
 * Whether an `Authorization: Bearer ...` header carries `secret`. Compares
 * fixed-length digests in constant time, so neither the secret's content nor
 * its length leaks through timing.
 */
export function bearerMatches(header: string | undefined, secret: string): boolean {
  const match = /^Bearer\s+(\S+)\s*$/.exec(header ?? "");
  const token = match?.[1] ?? "";
  const equal = timingSafeEqual(digest(token), digest(secret));
  return match !== null && equal;
}
