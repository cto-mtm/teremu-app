import { PosAuthError, type PosCredentials } from "../../types.js";
import { apiVersion, baseUrl } from "./config.js";

/** Square answered with an error that isn't "reconnect" (that's PosAuthError). */
export class SquareError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Plain fetch, no SDK — a handful of endpoints doesn't justify the
 * bundle. The one place that talks HTTP to Square: a 401 becomes
 * `PosAuthError` (the owner must reconnect), any other failure a
 * `SquareError` carrying the status.
 */
export async function call<T>(path: string, init: { method?: string; body?: unknown; auth?: string } = {}): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "Content-Type": "application/json",
      "Square-Version": apiVersion(),
      ...(init.auth ? { Authorization: init.auth } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await res.json().catch(() => ({}))) as T & { errors?: { code?: string; detail?: string }[] };
  if (res.status === 401) throw new PosAuthError();
  if (!res.ok) {
    const first = body.errors?.[0];
    throw new SquareError(res.status, `Square ${path} → ${res.status} ${first?.code ?? ""} ${first?.detail ?? ""}`.trim());
  }
  return body;
}

/** An authenticated call on behalf of a connected merchant. */
export const callAs = <T>(credentials: PosCredentials, path: string, init: { method?: string; body?: unknown } = {}) =>
  call<T>(path, { ...init, auth: `Bearer ${credentials.secret.accessToken}` });
