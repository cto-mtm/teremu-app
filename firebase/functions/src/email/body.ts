import { htmlToText } from "../helpers/html.js";
import type { MailBody } from "./types.js";

/**
 * Email body → plain text (docs/email-ingestion.md §Documents and
 * extraction paths): what the classifier previews and what the `body`
 * path extracts from. HTML goes through the shared converter with table
 * rows kept as tab-separated lines — an emailed invoice's rows are its
 * line items.
 */

/** Cap for the body path; the classifier previews far less. */
const MAX_BODY_CHARS = 12_000;

/** Where the new message ends and the quoted history begins. Not "De:" /
 * "From:" — a forwarded invoice starts with exactly those headers. */
const REPLY_MARKERS = [/^El .{3,200} escribió:$/, /^On .{3,200} wrote:$/, /^-{2,} ?(Original Message|Mensaje original) ?-{2,}$/i];

/** The body's text, tidied: the text part when the sender wrote one,
 * else the HTML converted; quoted replies and the signature trimmed. */
export function bodyText(body: MailBody): string {
  const raw = body.text?.trim() ? body.text : body.html ? htmlToText(body.html, { cells: "tabs" }) : "";
  const out: string[] = [];
  for (const line of raw.replace(/\r\n?/g, "\n").split("\n")) {
    const l = line.replace(/[  ]+/g, " ").replace(/ *\t */g, "\t").trimEnd();
    if (l === "--" || l === "-- " || REPLY_MARKERS.some((re) => re.test(l.trim()))) break;
    if (l.trimStart().startsWith(">")) continue;
    out.push(l.trimStart());
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_BODY_CHARS);
}
