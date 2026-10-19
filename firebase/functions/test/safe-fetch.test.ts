import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPublicAddress, safeFetch, SafeFetchError, type SafeFetchOptions } from "../src/helpers/safeFetch";

/**
 * safeFetch — the SSRF guard for URLs we didn't write (restaurant
 * websites; docs/restaurant-listing.md). In-process against a local
 * server: fake hostnames resolve through the test resolver, so nothing
 * here touches the network.
 */

describe("isPublicAddress", () => {
  it.each(["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700::1111", "2a00:1450:4003::1"])("allows %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // metadata server
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd12:3456::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1", // hex form of the same
    "::ffff:169.254.169.254",
    "64:ff9b::a00:1",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});

describe("safeFetch", () => {
  let server: Server;
  let port: number;
  let base: string;

  const HOSTS: Record<string, string[]> = {
    "menu.test": ["127.0.0.1"],
    "evil.test": ["169.254.169.254"],
    "mixed.test": ["93.184.216.34", "10.0.0.1"], // one bad address poisons the host
  };
  /** Loopback stands in for "the internet" here; every real range stays blocked. */
  const opts = (extra: SafeFetchOptions = {}): SafeFetchOptions => ({
    resolve: async (host) => (HOSTS[host] ?? []).map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
    isAllowedAddress: (ip) => ip === "127.0.0.1" || isPublicAddress(ip),
    ports: [80, 443, port],
    ...extra,
  });
  const fails = async (p: Promise<unknown>, code: SafeFetchError["code"]) => {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SafeFetchError);
    expect((err as SafeFetchError).code).toBe(code);
  };

  beforeAll(async () => {
    server = createServer((req, res) => {
      switch (req.url) {
        case "/menu":
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return res.end("<h1>Carta</h1><p>Paella 18,50</p>");
        case "/to-menu":
          res.writeHead(302, { location: "/menu" });
          return res.end();
        case "/to-evil":
          res.writeHead(301, { location: `http://evil.test:${port}/` });
          return res.end();
        case "/to-literal":
          res.writeHead(302, { location: "http://169.254.169.254/computeMetadata/v1/" });
          return res.end();
        case "/loop":
          res.writeHead(302, { location: "/loop" });
          return res.end();
        case "/json":
          res.writeHead(200, { "content-type": "application/json" });
          return res.end("{}");
        case "/big":
          res.writeHead(200, { "content-type": "text/html", "content-length": "5000" });
          return res.end("x".repeat(5000));
        case "/big-chunked":
          res.writeHead(200, { "content-type": "text/html" });
          res.write("x".repeat(3000));
          return res.end("x".repeat(3000));
        case "/gzip":
          res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
          return res.end(gzipSync("<p>Bravas 6,50</p>"));
        case "/gzip-bomb":
          res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
          return res.end(gzipSync(Buffer.alloc(200_000))); // ~200 bytes on the wire
        case "/missing":
          res.writeHead(404, { "content-type": "text/html" });
          return res.end("nope");
        case "/slow":
          return; // never answers
        default:
          res.writeHead(500);
          return res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
    base = `http://menu.test:${port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it("fetches an allowed page", async () => {
    const res = await safeFetch(`${base}/menu`, opts());
    expect(res.status).toBe(200);
    expect(res.contentType).toBe("text/html");
    expect(res.body.toString()).toContain("Paella 18,50");
  });

  it("follows a redirect and reports the final URL", async () => {
    const res = await safeFetch(`${base}/to-menu`, opts());
    expect(res.url).toBe(`${base}/menu`);
  });

  it("re-checks every redirect hop (redirect into the metadata server)", async () => {
    await fails(safeFetch(`${base}/to-evil`, opts()), "blocked_address");
    // An IP literal never reaches the socket's lookup — checked separately.
    await fails(safeFetch(`${base}/to-literal`, opts()), "blocked_address");
  });

  it("refuses a host when any of its addresses is private", async () => {
    await fails(safeFetch(`http://mixed.test:${port}/menu`, opts()), "blocked_address");
  });

  it("refuses private IP literals with the real policy", async () => {
    await fails(safeFetch(`http://127.0.0.1:${port}/menu`, { ports: [port] }), "blocked_address");
    await fails(safeFetch("http://169.254.169.254/computeMetadata/v1/"), "blocked_address");
    await fails(safeFetch("http://[::1]/"), "blocked_address");
  });

  it("refuses bad URLs before any connection", async () => {
    await fails(safeFetch("file:///etc/passwd", opts()), "bad_url");
    await fails(safeFetch("ftp://menu.test/carta.pdf", opts()), "bad_url");
    await fails(safeFetch(`http://user:pw@menu.test:${port}/menu`, opts()), "bad_url");
    await fails(safeFetch("http://menu.test:22/", opts()), "bad_url");
    await fails(safeFetch("not a url", opts()), "bad_url");
  });

  it("stops after too many redirects", async () => {
    await fails(safeFetch(`${base}/loop`, opts()), "too_many_redirects");
  });

  it("enforces the content-type allowlist", async () => {
    await fails(safeFetch(`${base}/json`, opts()), "bad_content_type");
  });

  it("caps the body by content-length and while streaming", async () => {
    await fails(safeFetch(`${base}/big`, opts({ maxBytes: 1000 })), "too_large");
    await fails(safeFetch(`${base}/big-chunked`, opts({ maxBytes: 1000 })), "too_large");
  });

  it("decodes gzip and counts decoded bytes (no zip bombs)", async () => {
    expect((await safeFetch(`${base}/gzip`, opts())).body.toString()).toBe("<p>Bravas 6,50</p>");
    await fails(safeFetch(`${base}/gzip-bomb`, opts({ maxBytes: 10_000 })), "too_large");
  });

  it("maps HTTP errors and timeouts", async () => {
    const err = await safeFetch(`${base}/missing`, opts()).catch((e: SafeFetchError) => e);
    expect(err).toMatchObject({ code: "http_error", status: 404 });
    await fails(safeFetch(`${base}/slow`, opts({ timeoutMs: 200 })), "timeout");
  });
});
