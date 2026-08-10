/**
 * End-to-end smoke test: spawns the built stdio server exactly as `npx` would,
 * speaks real MCP to it, and asserts the tools answer.
 *
 * This exists because unit tests mock the transport, and the failure this
 * catches - a broken bin entry, a bad import path in the emitted JS, a stray
 * write to stdout corrupting the protocol stream - only appears when the real
 * process is spawned.
 */

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const REQUIRED_TOOLS = ["cogdepot_discover", "cogdepot_get_started"];

/**
 * With a key configured the server must additionally expose the keyed tools.
 * The spec permits the tool set to vary by the authorization presented, and
 * this asserts it actually does rather than advertising tools that can only
 * fail. Set COGDEPOT_API_KEY to exercise this half.
 */
const KEYED_TOOLS = [
  "cogdepot_get_account",
  "cogdepot_update_profile",
  "cogdepot_get_domain_challenge",
  "cogdepot_verify_domain",
  "cogdepot_get_thread",
  "cogdepot_get_deal",
  "cogdepot_rate_deal",
];

const apiKey = process.env.COGDEPOT_API_KEY;

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/stdio.js"],
  // Without a key this exercises the zero-configuration path, which is the
  // property under test in CI. With one, the keyed half is covered too.
  // Every variable the server reads must be forwarded explicitly. An allowlist
  // that does not know about a new one fails in the most misleading way
  // available: the child silently runs with the default, and the feature looks
  // broken rather than unforwarded. That is exactly what happened the first
  // time COGDEPOT_API_BASE_URL was added - a staging key went to production and
  // came back 401.
  env: {
    PATH: process.env.PATH ?? "",
    ...(apiKey ? { COGDEPOT_API_KEY: apiKey } : {}),
    ...(process.env.COGDEPOT_API_BASE_URL
      ? { COGDEPOT_API_BASE_URL: process.env.COGDEPOT_API_BASE_URL }
      : {}),
  },
});

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log(`tools/list -> ${names.join(", ")}`);

for (const required of REQUIRED_TOOLS) {
  if (!names.includes(required)) fail(`tools/list is missing ${required}`);
}

if (apiKey) {
  for (const keyed of KEYED_TOOLS) {
    if (!names.includes(keyed)) fail(`with a key set, tools/list is missing ${keyed}`);
  }
} else {
  for (const keyed of KEYED_TOOLS) {
    if (names.includes(keyed)) fail(`${keyed} is advertised without a key and could only fail`);
  }
}

// No tool that spends credits may ship until the directory-eligibility question
// is answered. This guard is the mechanism that keeps that decision honest.
const GATED = ["search_listings", "get_listing", "post_listing", "open_thread", "finalize_deal"];
for (const gated of GATED) {
  if (names.some((n) => n.endsWith(gated))) {
    fail(`cogdepot_${gated} is registered but fee-incurring tools are still gated`);
  }
}

for (const tool of tools) {
  if (!tool.title) fail(`${tool.name} has no title (required by directory review)`);
  const hints = tool.annotations ?? {};
  if (hints.readOnlyHint === undefined && hints.destructiveHint === undefined) {
    fail(`${tool.name} declares neither readOnlyHint nor destructiveHint`);
  }
}

for (const name of REQUIRED_TOOLS) {
  const result = await client.callTool({ name, arguments: {} });
  const text = (result.content ?? []).map((c) => c.text ?? "").join("");
  if (result.isError) fail(`${name} returned isError`);
  if (text.trim().length === 0) fail(`${name} returned empty content`);
  console.log(`${name} -> ${text.length} chars, first line: ${text.split("\n")[0]}`);

  // The point of live facts: a real price must appear, not a placeholder.
  if (name === "cogdepot_discover" && !/credit/i.test(text)) {
    fail("cogdepot_discover returned no credit pricing");
  }
}

if (apiKey) {
  const account = await client.callTool({ name: "cogdepot_get_account", arguments: {} });
  const text = (account.content ?? []).map((c) => c.text ?? "").join("");
  if (account.isError) fail(`cogdepot_get_account returned isError: ${text}`);
  console.log("--- cogdepot_get_account ---");
  console.log(text);

  // A raw uUSD figure reaching a model is a defect: it reads 20000000 as a
  // quantity of credits rather than as $10.
  if (/_micro|micro_/.test(text)) fail("get_account leaked a raw uUSD field name");
  // A reputation score without the warm-start caveat reads 5.0 as a track
  // record when it is the default state of every new account.
  if (/rating/i.test(text) && !/synthetic/i.test(text)) {
    fail("get_account showed reputation without the warm-start caveat");
  }
}

await client.close();

if (process.exitCode) {
  console.error("smoke: FAILED");
} else {
  console.log("smoke: OK");
}
