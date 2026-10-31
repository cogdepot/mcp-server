/**
 * Shared response rendering.
 *
 * Both tool modules previously carried a near-identical key/value renderer that
 * had already drifted: one stringified nested objects onto a single line, the
 * other indented them. Two copies of the same function is one copy too many,
 * and the drift is what happens next.
 *
 * Most of what these functions print about a listing, thread or deal was written
 * by another party, and the reader is a language model that cannot tell a
 * response's own sentences from a stranger's unless the response marks them. So
 * that text never reaches the output bare: `untrustedInline` and `untrustedBlock`
 * are the only two ways it gets there, and a record's strings go through them
 * unless the field is one cogDepot assigns itself.
 */

import { MICRO_USD_PER_CREDIT, formatCredits } from "./money.js";
import { UNTRUSTED_EMPTY, UNTRUSTED_FENCE_TAG, UNTRUSTED_NOTICE } from "./strings.js";

/**
 * The fields whose strings cogDepot assigns, so they read as plain text.
 *
 * An allowlist rather than a list of the risky fields, so a field the API adds
 * later is marked untrusted until someone decides otherwise. Being wrong in that
 * direction costs a pair of backticks; the other direction hands a stranger's
 * text to a model unmarked.
 */
const SERVER_ASSIGNED_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "listing_id",
  "thread_id",
  "deal_id",
  "poster_id",
  "status",
  "turn",
  "role",
  "created_at",
  "updated_at",
  "expires_at",
]);

/** Control and format characters, except the tab and newline a block may keep. */
const INVISIBLE_CHARACTERS = /(?![\t\n])[\p{Cc}\p{Cf}]/gu;

/** Every line ending a stranger could use, including the two Unicode separators. */
const LINE_ENDINGS = /\r\n?|[\u2028\u2029]/g;

/**
 * Removes what a reader cannot see but a model still receives: escape sequences,
 * bidirectional overrides, zero-width characters and Unicode tag characters,
 * which can carry a whole sentence invisibly.
 *
 * Nothing visible is changed, and no markdown is backslash-escaped. A deal's
 * reveal goes through here too, and its credential and endpoint must come out
 * byte for byte: an escaped underscore is a credential that no longer verifies.
 * The fences below are what make the markdown inert.
 */
function cleanText(value: string): string {
  return value.replace(LINE_ENDINGS, "\n").replace(INVISIBLE_CHARACTERS, "");
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

/**
 * One stranger-written value on a single line, as a code span.
 *
 * The delimiter is one backtick longer than any run in the text, so the text
 * cannot close the span and start speaking as the response. Line breaks become
 * spaces, because a value that can start a line can forge a heading.
 */
export function untrustedInline(value: string): string {
  const oneLine = cleanText(value).replace(/\s*\n\s*/g, " ").trim();
  if (oneLine.length === 0) return UNTRUSTED_EMPTY;

  const delimiter = "`".repeat(longestBacktickRun(oneLine) + 1);
  // CommonMark needs the padding when the text itself starts or ends in a
  // backtick, or that backtick would join the delimiter.
  const padding = oneLine.startsWith("`") || oneLine.endsWith("`") ? " " : "";
  return `${delimiter}${padding}${oneLine}${padding}${delimiter}`;
}

/**
 * Multi-line stranger text as a tagged code fence, for the same reason a span is
 * longer than its text: the fence is one backtick longer than any run inside, so
 * no line of the text can close it.
 */
export function untrustedBlock(value: string): string {
  const cleaned = cleanText(value);
  const fence = "`".repeat(Math.max(3, longestBacktickRun(cleaned) + 1));
  return [`${fence}${UNTRUSTED_FENCE_TAG}`, cleaned, fence].join("\n");
}

/**
 * Renders an API response as readable lines, indenting nested structures rather
 * than collapsing them.
 *
 * Prose over brace-soup is deliberate: directory review rejects generic JSON
 * dumps, and a model follows a labelled list more reliably than a serialized
 * object. Null and undefined fields are dropped - "closed_at: null" tells a
 * reader nothing and invites a model to reason about a value that is absent.
 *
 * For a record another party can write into, which is why it is the default. The
 * caller's own account data uses `renderOwnRecord`.
 */
export function renderRecord(heading: string, body: Record<string, unknown> | undefined): string {
  if (!body) return `${heading}: the API returned no content.`;

  const lines = [`# ${heading}`, "", UNTRUSTED_NOTICE, ""];
  for (const [key, value] of Object.entries(body)) lines.push(...renderField(key, value));
  return lines.join("\n");
}

/** `renderRecord` for a record that holds only the caller's own data. */
export function renderOwnRecord(
  heading: string,
  body: Record<string, unknown> | undefined,
): string {
  if (!body) return `${heading}: the API returned no content.`;

  const lines = [`# ${heading}`];
  for (const [key, value] of Object.entries(body)) lines.push(...renderOwnField(key, value));
  return lines.join("\n");
}

/**
 * Renders one key/value pair as zero or more lines.
 *
 * Extracted from `renderRecord` so the listing renderer can reuse the µUSD and
 * nesting rules for the fields it does not lay out itself. The alternative was a
 * second field renderer that would have to remember the µUSD guard on its own,
 * which is how the guard came to be missing from two of three renderers in the
 * first place.
 *
 * Anything a stranger could have written comes out marked: a string outside
 * SERVER_ASSIGNED_FIELDS, and any nested structure, whose JSON carries the same
 * strings. The JSON stays in a fence rather than being re-rendered, so a reveal
 * the caller is told to store survives whole.
 */
export function renderField(key: string, value: unknown): string[] {
  if (typeof value === "object" && value !== null) {
    return [`- **${key}** (untrusted):`, untrustedBlock(JSON.stringify(value, null, 2))];
  }
  if (typeof value === "string" && !SERVER_ASSIGNED_FIELDS.has(key)) {
    const cleaned = cleanText(value).trim();
    return cleaned.includes("\n")
      ? [`- **${key}** (untrusted):`, untrustedBlock(cleaned)]
      : [`- **${key}** (untrusted): ${untrustedInline(cleaned)}`];
  }
  return renderOwnField(key, value);
}

function renderOwnField(key: string, value: unknown): string[] {
  if (value === null || value === undefined) return [];

  // A raw uUSD figure must never reach a model. `amount_micro: 1000000` reads
  // as a million of something; it is $1.00, or 2,000 credits. This is the same
  // class of confusion as the conversion bug that shipped in 0.1.2, and the
  // account renderer already guarded against it while the thread and deal
  // renderers did not - which is why it survived here.
  if (key.endsWith("_micro") && typeof value === "number") {
    const label = key.replace(/_micro$/, "");
    return [`- **${label}**: ${formatCredits(Math.floor(value / MICRO_USD_PER_CREDIT))}`];
  }

  if (typeof value === "object") {
    return [
      `- **${key}**:`,
      JSON.stringify(value, null, 2)
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n"),
    ];
  }
  return [`- **${key}**: ${String(value)}`];
}
