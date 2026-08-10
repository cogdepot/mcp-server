import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * stdout is the protocol channel.
 *
 * For a stdio MCP server, anything written to stdout that is not a JSON-RPC
 * message corrupts the stream. The client does not report "your server printed
 * something"; it reports a parse error, and the real fault is invisible. A
 * single stray `console.log` left in after debugging is enough.
 *
 * Nothing prevented that. The source is clean today, and this is here so it
 * stays clean tomorrow - the failure is silent, remote, and attributed to the
 * wrong thing, which is the combination worth a cheap guard.
 *
 * Diagnostics belong on stderr, which stdio.ts already uses.
 */

const SHIPPED = readdirSync("src").filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

describe("nothing shipped may write to stdout", () => {
  it("reads a non-trivial number of source files", () => {
    // Without this, a broken glob would make every case below pass vacuously.
    expect(SHIPPED.length).toBeGreaterThan(5);
  });

  it.each(SHIPPED)("%s does not call console.*", (file) => {
    const source = readFileSync(join("src", file), "utf8");
    expect(source).not.toMatch(/\bconsole\s*\./);
  });

  it.each(SHIPPED)("%s does not write to process.stdout", (file) => {
    const source = readFileSync(join("src", file), "utf8");
    expect(source).not.toMatch(/process\s*\.\s*stdout/);
  });

  it("still allows stderr, which is where diagnostics belong", () => {
    // stdio.ts reports a startup failure on stderr. If that ever disappears, a
    // failed start becomes silent rather than merely ugly.
    const stdio = readFileSync(join("src", "stdio.ts"), "utf8");
    expect(stdio).toMatch(/process\.stderr\.write/);
  });
});
