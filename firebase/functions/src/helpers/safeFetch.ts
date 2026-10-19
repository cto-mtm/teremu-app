import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

/**
 * GET a URL we did not write — a restaurant's website from Google, or one
 * the owner pasted (docs/restaurant-listing.md). Every other outbound call
 * in this codebase goes to a fixed host from config; this is the one that
 * doesn't, so it carries the SSRF guards:
 *
 *  - http/https only, default ports only, no credentials in the URL
 *  - every address a host resolves to must be public: no loopback,
 *    private, link-local (169.254.169.254 is the metadata server),
 *    CGNAT, multicast or reserved ranges, v4 or v6
 *  - the check runs in the socket's own DNS lookup, so the address that
 *    was checked is the address that is connected to (no DNS-rebinding
 *    gap between "check" and "fetch")
 *  - redirects are followed by hand, re-checked at every hop, at most 3
 *  - one deadline across all hops, a byte cap on the decoded body, and a
 *    content-type allowlist
 */

export type SafeFetchErrorCode =
  | "bad_url"
  | "blocked_address"
  | "too_many_redirects"
  | "timeout"
  | "too_large"
  | "bad_content_type"
  | "http_error"
  | "network";

export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export interface SafeResponse {
  /** Final URL after redirects. */
  url: string;
  status: number;
  /** Lower-cased mime type without parameters ("text/html"). */
  contentType: string;
  body: Buffer;
}

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

export interface SafeFetchOptions {
  /** Deadline for the whole fetch, redirects included. */
  timeoutMs?: number;
  /** Cap on the decoded body. */
  maxBytes?: number;
  maxRedirects?: number;
  /** Allowed mime types (exact match after lower-casing). */
  accept?: readonly string[];
  // Test seams — production never passes these.
  resolve?: Resolver;
  isAllowedAddress?: (ip: string) => boolean;
  ports?: readonly number[];
}

export const PAGE_TYPES = ["text/html", "application/xhtml+xml", "text/plain"] as const;
export const MENU_TYPES = [...PAGE_TYPES, "application/pdf", "image/jpeg", "image/png", "image/webp"] as const;

const DEFAULTS = {
  timeoutMs: 10_000,
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 3,
  accept: MENU_TYPES,
  ports: [80, 443],
};

const USER_AGENT = "Mozilla/5.0 (compatible; TeremuMenuReader/1.0)";

// ── Address policy ──────────────────────────────────────────────────

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, incl. the metadata server
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128],
  ["64:ff9b::", 96], // NAT64 — embeds an arbitrary v4 address
  ["100::", 64], // discard
  ["2001:db8::", 32], // documentation
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** True for an address it is safe to connect to from inside our network. */
export function isPublicAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return !blocked.check(ip, "ipv4");
  if (version !== 6) return false;
  // IPv4-mapped (::ffff:10.0.0.1) and its hex form (::ffff:a00:1) judge by the v4 inside.
  const mapped = /^::ffff:(?:0:)?(.+)$/i.exec(ip)?.[1];
  if (mapped !== undefined) {
    if (isIP(mapped) === 4) return isPublicAddress(mapped);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(mapped);
    if (!hex) return false;
    const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
    return isPublicAddress([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join("."));
  }
  return !blocked.check(ip, "ipv6");
}

const systemResolve: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** The socket's lookup: resolve, refuse if ANY address is non-public. */
function guardedLookup(resolve: Resolver, allowed: (ip: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        const bad = addresses.find((a) => !allowed(a.address));
        if (addresses.length === 0 || bad) {
          const err = new SafeFetchError("blocked_address", `blocked address for ${hostname}: ${bad?.address ?? "none"}`);
          callback(err as NodeJS.ErrnoException, "", 0);
        } else if (options.all) {
          (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, addresses);
        } else {
          callback(null, addresses[0].address, addresses[0].family);
        }
      },
      (err: NodeJS.ErrnoException) => callback(err, "", 0),
    );
  };
}

// ── Fetch ───────────────────────────────────────────────────────────

function checkUrl(raw: string, ports: readonly number[], allowed: (ip: string) => boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError("bad_url", `not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SafeFetchError("bad_url", `scheme ${url.protocol}`);
  if (url.username || url.password) throw new SafeFetchError("bad_url", "credentials in URL");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!ports.includes(port)) throw new SafeFetchError("bad_url", `port ${port}`);
  // Node never calls the socket's lookup for an IP literal — check it here.
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !allowed(host)) throw new SafeFetchError("blocked_address", `blocked address ${host}`);
  return url;
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const o = { ...DEFAULTS, ...opts };
  const allowed = o.isAllowedAddress ?? isPublicAddress;
  const lookup = guardedLookup(o.resolve ?? systemResolve, allowed);
  const deadline = AbortSignal.timeout(o.timeoutMs);

  let url = checkUrl(rawUrl, o.ports, allowed);
  for (let hop = 0; ; hop++) {
    const res = await get(url, lookup, deadline);
    const location = res.headers.location;
    if (REDIRECTS.has(res.statusCode ?? 0) && location) {
      res.resume(); // discard the redirect body
      if (hop >= o.maxRedirects) throw new SafeFetchError("too_many_redirects", `more than ${o.maxRedirects} redirects`);
      url = checkUrl(new URL(location, url).toString(), o.ports, allowed);
      continue;
    }
    const status = res.statusCode ?? 0;
    if (status < 200 || status >= 300) {
      res.resume();
      throw new SafeFetchError("http_error", `HTTP ${status}`, status);
    }
    const contentType = (res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (!o.accept.includes(contentType)) {
      res.resume();
      throw new SafeFetchError("bad_content_type", `content-type ${contentType || "(none)"}`);
    }
    const declared = Number(res.headers["content-length"]);
    if (Number.isFinite(declared) && declared > o.maxBytes) {
      res.destroy();
      throw new SafeFetchError("too_large", `content-length ${declared}`);
    }
    const body = await readCapped(res, o.maxBytes, deadline);
    return { url: url.toString(), status, contentType, body };
  }
}

function get(url: URL, lookup: LookupFunction, signal: AbortSignal): Promise<IncomingMessage> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        lookup,
        signal,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/pdf,image/*;q=0.8,*/*;q=0.1",
          "accept-encoding": "gzip, deflate, br",
        },
      },
      resolve,
    );
    req.on("error", (err) => reject(asSafeError(err, signal)));
    req.end();
  });
}

/** Decode (gzip/deflate/br) and collect, counting DECODED bytes — a
 * small compressed body can expand without limit. */
function readCapped(res: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const encoding = (res.headers["content-encoding"] ?? "").toLowerCase();
  const decoder =
    encoding === "gzip" || encoding === "x-gzip"
      ? createGunzip()
      : encoding === "deflate"
        ? createInflate()
        : encoding === "br"
          ? createBrotliDecompress()
          : null;
  const stream = decoder ? res.pipe(decoder) : res;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const fail = (err: unknown) => {
      res.destroy();
      decoder?.destroy();
      reject(asSafeError(err, signal));
    };
    const onAbort = () => fail(new SafeFetchError("timeout", "deadline exceeded"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) fail(new SafeFetchError("too_large", `body over ${maxBytes} bytes`));
      else chunks.push(chunk);
    });
    stream.on("end", () => {
      signal.removeEventListener("abort", onAbort);
      resolve(Buffer.concat(chunks));
    });
    stream.on("error", fail);
    res.on("error", fail);
  });
}

function asSafeError(err: unknown, signal: AbortSignal): SafeFetchError {
  if (err instanceof SafeFetchError) return err;
  // The lookup's SafeFetchError arrives wrapped by the socket layer on some Node versions.
  const cause = (err as { cause?: unknown })?.cause;
  if (cause instanceof SafeFetchError) return cause;
  if (signal.aborted) return new SafeFetchError("timeout", "deadline exceeded");
  return new SafeFetchError("network", err instanceof Error ? err.message : String(err));
}
