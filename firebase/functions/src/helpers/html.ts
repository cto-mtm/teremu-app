/**
 * HTML → plain text, without an HTML library: the pages we read (a
 * restaurant's menu site, an emailed invoice) need line structure, and
 * turning block elements into line breaks is all of it. Shared by the
 * listing import (listing/website.ts) and email ingestion (email/body.ts).
 */

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", euro: "€",
  middot: "·", hellip: "…", ndash: "–", mdash: "—", laquo: "«", raquo: "»",
  iexcl: "¡", iquest: "¿", ordm: "º", ordf: "ª", deg: "°",
  ntilde: "ñ", Ntilde: "Ñ", ccedil: "ç", Ccedil: "Ç", uuml: "ü", Uuml: "Ü",
};
// á é í ó ú, à è ì ò ù and capitals — the accents Spanish pages are full of.
for (const v of "aeiou") {
  for (const [name, mark] of [["acute", "́"], ["grave", "̀"]]) {
    ENTITIES[`${v}${name}`] = `${v}${mark}`.normalize("NFC");
    ENTITIES[`${v.toUpperCase()}${name}`] = `${v.toUpperCase()}${mark}`.normalize("NFC");
  }
}

/** Named (case-sensitive first: &Aacute; ≠ &aacute;) and numeric entities. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code] ?? ENTITIES[code.toLowerCase()] ?? whole;
  });
}

const BLOCKS = "p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|nav|dt|dd|dl|blockquote";

/**
 * Readable lines: scripts, styles and comments dropped, one line per
 * block, tags gone, entities decoded, blank lines removed.
 *
 * `cells`: "lines" puts each table cell on its own line (a menu site);
 * "tabs" keeps a table row on one line with tab-separated cells (an
 * emailed invoice, whose rows are the line items).
 */
export function htmlToText(html: string, opts: { cells?: "lines" | "tabs" } = {}): string {
  const tabs = opts.cells === "tabs";
  const blocks = new RegExp(`<\\/?(${tabs ? BLOCKS : `${BLOCKS}|td|th`})\\b[^>]*>`, "gi");
  let text = html
    .replace(/<(script|style|noscript|svg|template|head|title)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n");
  if (tabs) text = text.replace(/<\/(td|th)\s*>/gi, "\t");
  text = decodeEntities(text.replace(blocks, "\n").replace(/<[^>]+>/g, " "));
  return text
    .split("\n")
    .map((line) =>
      tabs
        ? line.replace(/[ \f\v ]+/g, " ").replace(/ *\t */g, "\t").trim()
        : line.replace(/[ \t\f\v ]+/g, " ").trim(),
    )
    .filter(Boolean)
    .join("\n");
}
