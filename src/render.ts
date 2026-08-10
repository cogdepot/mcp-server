/**
 * Shared response rendering.
 *
 * Both tool modules previously carried a near-identical key/value renderer that
 * had already drifted: one stringified nested objects onto a single line, the
 * other indented them. Two copies of the same function is one copy too many,
 * and the drift is what happens next.
 */

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
