import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Constraints the MCP Registry enforces on server.json.
 *
 * These exist because 0.1.1 published to npm and then failed at the registry
 * with `422 body.description: expected length <= 100`. npm cannot be unpublished
 * freely, so half a release shipped and the version number was spent on a rule
 * that a one-line check would have caught before the tag was ever created.
 *
 * Registry rules discovered the expensive way belong here, not in a comment.
 */

const server = JSON.parse(readFileSync("server.json", "utf8")) as {
  name: string;
  description: string;
  version: string;
  packages: { identifier: string; version: string }[];
};
const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  name: string;
  version: string;
  mcpName: string;
};

describe("server.json", () => {
  it("keeps the description within the registry's 100-character limit", () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it("matches package.json mcpName exactly, which is a hard publish blocker", () => {
    expect(server.name).toBe(pkg.mcpName);
  });

  it("names the published package", () => {
    expect(server.packages[0]?.identifier).toBe(pkg.name);
  });

  it("keeps every version field in step", () => {
    // The publish workflow asserts this against the git tag too, but failing
    // here means it never reaches a tag - and a tag is the thing that cannot
    // be taken back once npm has seen it.
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0]?.version).toBe(pkg.version);
  });

  it("uses the io.github namespace the GitHub org authenticates", () => {
    expect(server.name).toMatch(/^io\.github\.cogdepot\//);
  });
});
