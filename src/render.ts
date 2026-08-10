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
  for (const [key, value] of Object.entries(body)) {
    if (value === null || value === undefined) continue;

    // A raw uUSD figure must never reach a model. `amount_micro: 1000000` reads
    // as a million of something; it is $1.00, or 2,000 credits. This is the same
    // class of confusion as the conversion bug that shipped in 0.1.2, and the
    // account renderer already guarded against it while the thread and deal
    // renderers did not - which is why it survived here.
    if (key.endsWith("_micro") && typeof value === "number") {
      const label = key.replace(/_micro$/, "");
      lines.push(`- **${label}**: ${formatCredits(Math.floor(value / MICRO_USD_PER_CREDIT))}`);
      continue;
    }

    // The API returns both `id` and `thread_id`, and `thread_id` is a truncated
    // prefix that 404s on every path that takes an id. Relaying it unlabelled
    // hands a model a broken identifier that looks like the right one. Filed
    // against the API as T985(c); until it changes, say what it is.
    if (key === "thread_id" && typeof value === "string") {
      lines.push(
        `- **${key}**: ${value} (short display form - NOT usable as an id; use \`id\` above)`,
      );
      continue;
    }
    if (typeof value === "object") {
      lines.push(`- **${key}**:`);
      lines.push(
        JSON.stringify(value, null, 2)
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n"),
      );
    } else {
      lines.push(`- **${key}**: ${String(value)}`);
    }
  }
  return lines.join("\n");
}
