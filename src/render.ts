/**
 * Shared response rendering.
 *
 * Both tool modules previously carried a near-identical key/value renderer that
 * had already drifted: one stringified nested objects onto a single line, the
 * other indented them. Two copies of the same function is one copy too many,
 * and the drift is what happens next.
 */

import { MICRO_USD_PER_CREDIT, formatCredits } from "./money.js";

/**
 * Renders an API response as readable lines, indenting nested structures rather
 * than collapsing them.
 *
 * Prose over brace-soup is deliberate: directory review rejects generic JSON
 * dumps, and a model follows a labelled list more reliably than a serialized
 * object. Null and undefined fields are dropped - "closed_at: null" tells a
 * reader nothing and invites a model to reason about a value that is absent.
 */
export function renderRecord(heading: string, body: Record<string, unknown> | undefined): string {
  if (!body) return `${heading}: the API returned no content.`;

  const lines = [`# ${heading}`];
  for (const [key, value] of Object.entries(body)) lines.push(...renderField(key, value));
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
 */
export function renderField(key: string, value: unknown): string[] {
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

  // The API returns both `id` and `thread_id`, and `thread_id` is a truncated
  // prefix that 404s on every path that takes an id. Relaying it unlabelled
  // hands a model a broken identifier that looks like the right one. Filed
  // upstream against the API; until that ships, say what it is.
  if (key === "thread_id" && typeof value === "string") {
    return [`- **${key}**: ${value} (short display form - NOT usable as an id; use \`id\` above)`];
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
