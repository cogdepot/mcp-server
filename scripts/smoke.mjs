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

const REQUIRED_TOOLS = [
  "cogdepot_discover",
  "cogdepot_get_started",
  // Keyless, and the only one that leaves api.cogdepot.com. Spawning the real
  // process is the only way to catch the storefront host being unreachable or
  // answering HTML, since the unit tests necessarily mock that fetch.
  "cogdepot_preview_listings",
  // Keyless too, and the first tool here that answers a question about somebody
  // else. It reads a live public record from the API and sends no credential
  // even when one is configured, so spawning the real process is what proves
  // both halves: that the route answers, and that the tool is advertised
  // without a key.
  "cogdepot_get_reputation",
  // Keyless as well, and the only one that speaks to the market as a whole
  // rather than to one listing or one counterparty. Spawned rather than mocked
  // for the same reason as the preview: this route lives on api.cogdepot.com
  // outside /v1, so a redirect or an HTML error page there is invisible to the
  // unit tests, which necessarily stub the fetch.
  "cogdepot_get_stats",
];

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
  "cogdepot_get_my_listings",
  "cogdepot_browse_feed",
  "cogdepot_get_listing",
  "cogdepot_post_listing",
  "cogdepot_list_listing_threads",
  "cogdepot_open_thread",
  "cogdepot_submit_offer",
  "cogdepot_close_thread",
  "cogdepot_finalize_deal",
];

/**
 * Tools this script must never invoke, because it runs against production with
 * a real key and these spend real money or take irreversible action.
 *
 * Asserting they are REGISTERED is the point of the smoke test; calling them is
 * not. A finalize here would charge $1.00 per side and reveal two parties'
 * contact details, on every CI run.
 *
 * This is a denylist and denylists rot, so it is checked against the registered
 * set below rather than trusted: anything registered that is not on the callable
 * list is treated as unsafe to call, which fails closed for tools added later.
 */
const SAFE_TO_CALL = [
  "cogdepot_discover",
  "cogdepot_get_started",
  "cogdepot_preview_listings",
  // Free, unmetered, keyless and read-only. Unlike everything else here it takes
  // a required argument, so the call loop supplies one from SMOKE_ARGS.
  "cogdepot_get_reputation",
  "cogdepot_get_stats",
  "cogdepot_get_account",
  "cogdepot_get_my_listings",
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

// Pin the EXACT set rather than the absence of names this file happens to know.
// An earlier denylist would have passed a newly added `cogdepot_browse`, which
// was exactly the tool it was meant to catch. Pinning means any new tool fails
// here until somebody adds it deliberately - and that moment is when they have
// to decide whether it costs the user money and annotate it accordingly.
const EXPECTED = [...REQUIRED_TOOLS, ...(apiKey ? KEYED_TOOLS : [])].sort();
if (JSON.stringify(names) !== JSON.stringify(EXPECTED)) {
  fail(`unexpected tool set.\n  got:      ${names.join(", ")}\n  expected: ${EXPECTED.join(", ")}`);
}

// Fail closed: anything registered that this script has not explicitly cleared
// as safe is treated as unsafe to call here, so a tool added later cannot be
// swept into the call loop by someone extending REQUIRED_TOOLS.
for (const name of REQUIRED_TOOLS) {
  if (!SAFE_TO_CALL.includes(name)) {
    fail(`${name} is in REQUIRED_TOOLS but not cleared as safe to call against production`);
  }
}

// Every tool that moves credits must say so where a model will read it, and
// must not claim to be read-only. This is the guard that replaced the
// eligibility gate: the tools ship, and what is enforced is that they are
// honest about the price before anything is spent.
const SPENDS_CREDITS = [
  "cogdepot_browse_feed", // 1 credit
  "cogdepot_get_listing", // 1 credit
  "cogdepot_post_listing", // 200 + 1
  "cogdepot_open_thread", // 2000 held
  "cogdepot_finalize_deal", // 2000 per side, captured
];
if (apiKey) {
  for (const name of SPENDS_CREDITS) {
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      fail(`${name} moves credits and must be registered with a key set`);
      continue;
    }
    if (!/credit/i.test(tool.description ?? "")) {
      fail(`${name} moves credits but its description never says the word`);
    }
    if (tool.annotations?.readOnlyHint === true) {
      fail(`${name} moves credits but claims readOnlyHint: true`);
    }
  }
  // The irreversible pair must be annotated so a host prompts before running
  // them unattended. Getting this wrong is how a deal seals without anyone
  // deciding to seal it.
  for (const name of ["cogdepot_finalize_deal", "cogdepot_close_thread"]) {
    const tool = tools.find((t) => t.name === name);
    if (tool?.annotations?.destructiveHint !== true) {
      fail(`${name} is irreversible but does not declare destructiveHint: true`);
    }
  }
}

for (const tool of tools) {
  if (!tool.title) fail(`${tool.name} has no title (required by directory review)`);
  const hints = tool.annotations ?? {};
  if (hints.readOnlyHint === undefined && hints.destructiveHint === undefined) {
    fail(`${tool.name} declares neither readOnlyHint nor destructiveHint`);
  }
}

// Arguments for the tools that require them. Everything else is called bare.
//
// The handle is cogDepot's own seeded account, read from the live preview feed
// as `poster_id` - a public identifier that appears on every listing, so using
// it here discloses nothing. A handle that stops existing makes this fail with a
// 404, which is the correct outcome: it means the record this tool exists to
// read is gone.
const SMOKE_ARGS = {
  cogdepot_get_reputation: { handle: "25ebb92a8a1b" },
};

for (const name of REQUIRED_TOOLS) {
  const result = await client.callTool({ name, arguments: SMOKE_ARGS[name] ?? {} });
  const text = (result.content ?? []).map((c) => c.text ?? "").join("");
  if (result.isError) {
    // The preview takes no API key and is rate limited per IP, so a busy shared
    // CI runner can be refused legitimately. That is the endpoint behaving as
    // documented rather than a broken build; every other error still fails.
    if (name === "cogdepot_preview_listings" && /rate limited/i.test(text)) {
      console.log(`${name} -> rate limited per IP, which is documented behaviour, not a failure`);
      continue;
    }
    fail(`${name} returned isError: ${text}`);
  }
  if (/_micro/.test(text)) fail(`${name} leaked a raw uUSD field name`);
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

  // /v1/listings/mine is absent from the published OpenAPI, so this spawned run
  // is the only place its real response shape is ever exercised. A parser built
  // against a guess is worth checking against the thing itself.
  const mine = await client.callTool({ name: "cogdepot_get_my_listings", arguments: {} });
  const mineText = (mine.content ?? []).map((c) => c.text ?? "").join("");
  if (mine.isError) fail(`cogdepot_get_my_listings returned isError: ${mineText}`);
  if (/_micro/.test(mineText)) fail("get_my_listings leaked a raw uUSD field name");
  console.log("--- cogdepot_get_my_listings ---");
  console.log(mineText);
}

await client.close();

if (process.exitCode) {
  console.error("smoke: FAILED");
} else {
  console.log("smoke: OK");
}
