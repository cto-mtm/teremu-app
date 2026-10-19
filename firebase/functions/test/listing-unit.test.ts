import { describe, expect, it } from "vitest";
import { mockMenuFromText } from "../src/menuscan";
import { fakeBackend } from "../src/listing/fake";
import { mergeCandidates } from "../src/listing/merge";
import { emailMatchesDomain, verifiableDomain } from "../src/listing/verify";
import { crawlForMenu, htmlToText, normalizeWebsite } from "../src/listing/website";

/**
 * The pure parts of the listing import (docs/restaurant-listing.md) —
 * in-process, no emulator. The HTTP flow is in listing.test.ts.
 */

describe("htmlToText", () => {
  it("keeps one line per block and drops scripts, styles and tags", () => {
    const text = htmlToText(
      `<html><head><title>x</title><style>.a{}</style></head><body><script>alert(1)</script>
       <h2>Arroces</h2><ul><li>Paella &amp; marisco ........ 18,50&nbsp;&euro;</li><li>Arroz <b>negro</b> 16,00 €</li></ul>
       <!-- comment --><p>Fideu&#224; 15,00 €</p></body></html>`,
    );
    expect(text.split("\n")).toEqual(["Arroces", "Paella & marisco ........ 18,50 €", "Arroz negro 16,00 €", "Fideuà 15,00 €"]);
  });
});

describe("normalizeWebsite", () => {
  it.each([
    ["lalupita.es", "https://lalupita.es/"],
    ["http://bar.example/carta", "http://bar.example/carta"],
    ["  https://Casa.example  ", "https://casa.example/"],
  ])("%s → %s", (raw, url) => expect(normalizeWebsite(raw)).toBe(url));

  it.each(["", "not a site", "ftp://menu.example", "localhost", "javascript:alert(1)"])("rejects %j", (raw) => {
    expect(normalizeWebsite(raw)).toBeNull();
  });
});

describe("mockMenuFromText (offline menu parser)", () => {
  it("reads name … price lines under section headings", () => {
    const r = mockMenuFromText("Arroces\nPaella de marisco ........ 18,50 €\nArroz negro 16 €\nPostres\nTarta de queso · 6,00\nCocina valenciana desde 1987.");
    expect(r.dishes).toEqual([
      { name: "Paella de marisco", price: 18.5, section: "Arroces" },
      { name: "Arroz negro", price: 16, section: "Arroces" },
      { name: "Tarta de queso", price: 6, section: "Postres" },
    ]);
  });

  it("says when there is no menu", () => {
    expect(mockMenuFromText("Desayunos y meriendas en el centro. ¡Te esperamos!")).toEqual({ dishes: [], notMenu: true });
  });
});

describe("crawlForMenu (fixture sites)", () => {
  const crawl = (url: string) => crawlForMenu(fakeBackend.fetchPage, url);

  it("follows the menu link from the home page", async () => {
    const r = await crawl("https://tabernaelfaro.example/");
    expect(r.reachable).toBe(true);
    expect(r.pages.map((p) => [p.url, p.kind])).toEqual([
      ["https://tabernaelfaro.example/", "text"],
      ["https://tabernaelfaro.example/carta", "text"],
    ]);
    expect(r.pages[1].text).toContain("Paella de marisco ........ 18,50 €");
  });

  it("finds a menu image on the menu page", async () => {
    const r = await crawl("https://casalucia.example/");
    expect(r.pages.map((p) => p.kind)).toEqual(["text", "text", "image"]);
    expect(r.pages[2].imageBase64).toBeTruthy();
  });

  it("reports a PDF-only menu", async () => {
    const r = await crawl("https://nonnapia.example/");
    expect(r.pages.map((p) => p.kind)).toEqual(["text", "pdf"]);
  });

  it("is unreachable when the site doesn't answer", async () => {
    expect(await crawl("https://nowhere.example/")).toEqual({ reachable: false, homeUrl: null, pages: [] });
  });
});

describe("mergeCandidates", () => {
  const dish = (name: string, price: number | null, section: string | null = null) => ({ name, price, section, source: "website" as const });

  it("dedupes by folded name and keeps the second price as the alternative", () => {
    const out = mergeCandidates([], [dish("Paella de marisco", 18.5, "Arroces"), dish("PAELLA DE MARISCO", 16), dish("Patatas bravas", 6.5)], []);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ name: "Paella de marisco", price: 18.5, altPrice: 16, section: "Arroces" });
    expect(out[1].altPrice).toBeUndefined();
  });

  it("matches the existing menu: exact names and strong fuzzy ones", () => {
    const menu = [
      { id: "m1", name: "Patatas Bravas", price: 5 },
      { id: "m2", name: "Croquetas caseras de jamón", price: 7 },
      { id: "m3", name: "Ensalada", price: 8 },
    ];
    const out = mergeCandidates([], [dish("Patatas bravas", 6.5), dish("Croquetas de jamón caseras", 8), dish("Pulpo a la brasa", 17.5)], menu);
    expect(out[0].match).toEqual({ menuItemId: "m1", kind: "exact", name: "Patatas Bravas", price: 5 });
    expect(out[1].match?.menuItemId).toBe("m2");
    expect(out[2].match).toBeUndefined();
  });

  it("appends to an earlier run without losing its rows", () => {
    const first = mergeCandidates([], [dish("Tacos al pastor", 9)], []);
    const second = mergeCandidates(first, [dish("Guacamole", 7.5), dish("Tacos al pastor", 9)], []);
    expect(second.map((c) => c.name)).toEqual(["Tacos al pastor", "Guacamole"]);
  });
});

describe("claim verification domains", () => {
  it.each([
    ["https://www.tabernaelfaro.es/", "tabernaelfaro.es"],
    ["https://carta.casalucia.example/menu", "carta.casalucia.example"],
    ["https://www.facebook.com/tabernaelfaro", null], // someone else's platform
    ["https://faro.wixsite.com/inicio", null],
    ["https://sites.google.com/view/faro", null],
    [null, null],
  ])("verifiableDomain(%j) → %j", (website, domain) => {
    expect(verifiableDomain(website)).toBe(domain);
  });

  it.each([
    ["info@tabernaelfaro.es", "tabernaelfaro.es", true],
    ["INFO@TabernaElFaro.es", "tabernaelfaro.es", true],
    ["chef@carta.tabernaelfaro.es", "tabernaelfaro.es", true],
    ["info@tabernaelfaro.es", "carta.tabernaelfaro.es", true],
    ["faro@gmail.com", "tabernaelfaro.es", false],
    ["info@eltabernaelfaro.es", "tabernaelfaro.es", false],
    ["not-an-email", "tabernaelfaro.es", false],
  ])("emailMatchesDomain(%s, %s) → %s", (email, domain, ok) => {
    expect(emailMatchesDomain(email, domain)).toBe(ok);
  });
});
