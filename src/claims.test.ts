import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ALLOWED_API_DOMAIN } from "./config.js";
import { buildServer } from "./core.js";

/**
 * Guards the claims this package makes about itself.
 *
 * Every defect found between review passes 5 and 8 was the same shape: the code
 * was right and something *describing* the code was wrong. A stale
 * SERVER_VERSION advertised over the protocol. A privacy policy naming one host
 * when the code could reach a whole domain - twice. A registry entry omitting an
 * environment variable. A plan claiming a spec revision the transport does not
 * negotiate.
 *
 * That is a structural weakness rather than a run of bad luck. This package
 * carries an unusual amount of prose making checkable claims: tool descriptions
 * a model acts on, a privacy policy read during directory review, a registry
 * entry, a README. Almost none of it was enforced by anything.
 *
 * These tests make the claims mechanical. They do not check that the prose is
 * well written; they check that it has not drifted from what the code does.
 */

const SRC = "src";
const README = readFileSync("README.md", "utf8");
const PRIVACY = readFileSync("PRIVACY.md", "utf8");
const SERVER_JSON = JSON.parse(readFileSync("server.json", "utf8")) as {
  packages: { environmentVariables?: { name: string }[] }[];
};

/** Environment variables the shipped code actually reads. */
function environmentVariablesRead(): string[] {
  const found = new Set<string>();
  for (const file of readdirSync(SRC)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const source = readFileSync(join(SRC, file), "utf8");
    for (const match of source.matchAll(/process\.env\[["']([A-Z0-9_]+)["']\]/g)) {
      if (match[1]) found.add(match[1]);
    }
  }
  return [...found].sort();
}

/** Tool names the server actually registers, read over the protocol. */
async function registeredToolNames(): Promise<string[]> {
  return (await registeredNames()).tools;
}

/**
 * Every `cogdepot_`-prefixed name the server registers, by surface.
 *
 * Prompts share the tools' prefix deliberately - clients differ on whether they
 * group a server's prompts under its name or flatten them into one list, and the
 * prefix is the only form that reads correctly in both. The consequence is that
 * the README guard cannot assume a `cogdepot_x` mention is a tool, so it checks
 * against the union and the "registered but undocumented" check runs per surface.
 */
async function registeredNames(): Promise<{ tools: string[]; prompts: string[] }> {
  const { Client } = await import("@modelcontextprotocol/client");
  const { InMemoryTransport } = await import("@modelcontextprotocol/server");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "claims", version: "0.0.0" });
  await Promise.all([
    buildServer("claims-check-not-a-real-key").connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const { tools } = await client.listTools();
  const { prompts } = await client.listPrompts();
  await client.close();
  return {
    tools: tools.map((t) => t.name).sort(),
    prompts: prompts.map((p) => p.name).sort(),
  };
}

describe("environment variables", () => {
  const variables = environmentVariablesRead();

  it("reads at least the two it is supposed to", () => {
    // A sanity check on the extraction itself: if the regex silently stopped
    // matching, every assertion below would pass vacuously.
    expect(variables).toContain("COGDEPOT_API_KEY");
    expect(variables).toContain("COGDEPOT_API_BASE_URL");
  });

  it.each(environmentVariablesRead())("%s is documented in the README", (name) => {
    expect(README).toContain(name);
  });

  it.each(environmentVariablesRead())("%s is declared in server.json", (name) => {
    const declared = (SERVER_JSON.packages[0]?.environmentVariables ?? []).map((e) => e.name);
    expect(declared).toContain(name);
  });

  it.each(environmentVariablesRead())("%s is accounted for in the privacy policy", (name) => {
    // Both variables affect where data goes: one IS the credential, the other
    // decides the destination. A privacy policy that omits either is describing
    // a different program.
    expect(PRIVACY).toContain(name);
  });
});

describe("the privacy policy describes the real network behaviour", () => {
  it("names the domain the key may actually be sent to", () => {
    // It said "sent only to api.cogdepot.com" for a while after the override
    // made that false. The policy has to describe the constraint that holds.
    expect(PRIVACY).toContain(ALLOWED_API_DOMAIN);
  });

  it("does not promise a single host now that a whole domain is reachable", () => {
    expect(PRIVACY).not.toMatch(/sent only to `?api\.cogdepot\.com`?/);
  });
});

describe("the README does not describe an unreleased package", () => {
  // The Status section said "Not yet published to npm" for a day after three
  // versions were on npm and the MCP Registry. Sixteen review passes walked past
  // it, and this file - written specifically to catch claims drifting from
  // reality - was checking env vars, tool names and hosts, and not prose.
  //
  // It matters more than a GitHub typo: README.md ships inside the tarball and
  // npmjs.com renders the packaged copy, so the npm page for a published package
  // was telling visitors it was not published.
  const UNRELEASED_LANGUAGE = [
    /not yet published/i,
    /\bunreleased\b/i,
    /\bcoming soon\b/i,
    /\bnot published\b/i,
    /\bpre-?release\b/i,
  ];

  it.each(UNRELEASED_LANGUAGE)("says nothing matching %s", (pattern) => {
    expect(README).not.toMatch(pattern);
  });

  it("names the published package and the registry entry", () => {
    // A weak positive to sit against the negatives above: the Status section has
    // to point at something real, or "no forbidden phrases" is satisfiable by
    // saying nothing at all.
    expect(README).toContain("@cogdepot/mcp-server");
    expect(README).toContain("io.github.cogdepot/cogdepot");
  });
});

describe("the README lists the tools that exist", () => {
  it("documents every registered tool", async () => {
    for (const name of await registeredToolNames()) {
      expect(README, `${name} is registered but absent from the README`).toContain(name);
    }
  });

  it("does not advertise a tool or prompt that is not registered", async () => {
    const { tools, prompts } = await registeredNames();
    const registered = new Set([...tools, ...prompts]);
    const mentioned = [...README.matchAll(/`(cogdepot_[a-z_]+)`/g)].map((m) => m[1] as string);
    for (const name of new Set(mentioned)) {
      expect(registered.has(name), `${name} is in the README but not registered`).toBe(true);
    }
  });

  it("lists every prompt the server registers", async () => {
    // The same trap the tool list already guards, one surface over: a prompt
    // added without a README row is a feature nobody can find, and one removed
    // without deleting the row is a promise the server no longer keeps.
    for (const name of (await registeredNames()).prompts) {
      expect(README, `${name} is registered but absent from the README`).toContain(name);
    }
  });
});
