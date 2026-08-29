/**
 * Proves the optional route declaration survives a real round trip.
 *
 *   node scripts/with-keys.mjs staging verify:route
 *
 * The unit tests assert what the TOOL sends; the OpenAPI document asserts what
 * the API accepts. Neither can say the two agree, and the failure mode when
 * they do not is silent: the API ignores unknown JSON fields, so a tool sending
 * a field the deployment does not know returns success with nothing stored.
 * Only a write followed by a read of the same account can tell those apart.
 *
 * Staging only, and the outer guard in with-keys.mjs is what enforces that -
 * this refuses production independently, on the same reasoning as e2e.mjs: it
 * WRITES to the account the key belongs to, and on production that account is
 * the live directory-review one.
 *
 * The account is left as it was found. A route write is replace-on-write, so
 * this captures the declaration first and restores it at the end, including
 * the case where there was nothing to restore.
 */

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const apiKey = process.env.COGDEPOT_API_KEY;
const baseUrl = process.env.COGDEPOT_API_BASE_URL;

if (!apiKey) {
  console.error("verify-route: COGDEPOT_API_KEY is not set. Run this through scripts/with-keys.mjs.");
  process.exit(2);
}
if (!baseUrl) {
  console.error("verify-route: COGDEPOT_API_BASE_URL is not set. Run this through scripts/with-keys.mjs.");
  process.exit(2);
}
// The script's own refusal, independent of the one in with-keys.mjs. This
// writes to the account the key belongs to, and on production that is the
// account a directory reviewer sees.
if (/^https:\/\/(api\.)?cogdepot\.com/.test(baseUrl)) {
  console.error(`verify-route: refusing to run against production (${baseUrl}). It writes to the account the key belongs to.`);
  process.exit(1);
}

const BINDING = "HTTP+JSON";
const CARD = "https://verify.example/.well-known/agent-card.json";

const failures = [];
function check(ok, message) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${message}`);
  if (!ok) failures.push(message);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/stdio.js"],
  env: { PATH: process.env.PATH ?? "", COGDEPOT_API_KEY: apiKey, COGDEPOT_API_BASE_URL: baseUrl },
});
const client = new Client({ name: "verify-route", version: "0.0.0" });
await client.connect(transport);

async function callText(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");
  return { text, isError: Boolean(result.isError) };
}

/** Reads the profile straight from the API, which is the side under test. */
async function profile() {
  const res = await fetch(`${baseUrl}/v1/account/profile`, { headers: { "x-api-key": apiKey } });
  if (!res.ok) throw new Error(`GET /v1/account/profile answered ${res.status}`);
  return res.json();
}

console.log(`\nverify-route against ${baseUrl}\n`);

const before = await profile();
console.log("profile as found:");
console.log(`  deal_route             ${JSON.stringify(before.deal_route)}`);
console.log(`  route_protocol_binding ${JSON.stringify(before.route_protocol_binding)}`);
console.log(`  agent_card_url         ${JSON.stringify(before.agent_card_url)}\n`);

// Gate: both keys must EXIST in the response, null or not. Their absence means
// the deployment predates the change and would discard the declaration while
// answering 204.
check(
  "route_protocol_binding" in before && "agent_card_url" in before,
  "the profile response carries both declaration keys",
);
if (failures.length) {
  console.error("\nThe API has not deployed the route declaration. Nothing was written.");
  await client.close();
  process.exit(1);
}

const contact = before.contact ?? {};
if (!contact.contact_name || !contact.contact_email || !before.deal_route) {
  console.error("verify-route: this account has no complete profile to preserve. Set one first.");
  await client.close();
  process.exit(2);
}

// The write, through the tool rather than around it: what is under test is
// whether the TOOL's body reaches the API intact.
const wrote = await callText("cogdepot_update_profile", {
  contact_name: contact.contact_name,
  contact_email: contact.contact_email,
  deal_route: before.deal_route,
  ...(contact.contact_url ? { contact_url: contact.contact_url } : {}),
  route_protocol_binding: BINDING,
  agent_card_url: CARD,
});
check(!wrote.isError, `cogdepot_update_profile accepted the declaration (${wrote.text.split("\n")[0]})`);

const after = await profile();
check(after.route_protocol_binding === BINDING, `route_protocol_binding round-tripped as ${JSON.stringify(after.route_protocol_binding)}`);
check(after.agent_card_url === CARD, `agent_card_url round-tripped as ${JSON.stringify(after.agent_card_url)}`);
check(after.deal_route === before.deal_route, "deal_route was preserved by the write");

// Replace-on-write, asserted rather than assumed: omitting the fields must
// CLEAR them. This is the behaviour both tool descriptions promise, and it is
// the one an agent is most likely to trip over.
const cleared = await callText("cogdepot_update_profile", {
  contact_name: contact.contact_name,
  contact_email: contact.contact_email,
  deal_route: before.deal_route,
  ...(contact.contact_url ? { contact_url: contact.contact_url } : {}),
});
check(!cleared.isError, "a write omitting both fields was accepted");

const afterClear = await profile();
check(afterClear.route_protocol_binding === null, `omitting the binding CLEARED it (now ${JSON.stringify(afterClear.route_protocol_binding)})`);
check(afterClear.agent_card_url === null, `omitting the card CLEARED it (now ${JSON.stringify(afterClear.agent_card_url)})`);

// Does the API actually enforce the rules the tool description promises?
//
// The tool refuses these before they reach the wire, so the descriptions are a
// CLAIM about the server that nothing here has tested. If the server is looser,
// the tool blocks input the API would have taken; if stricter, an agent meets a
// 400 the description did not warn about. Both are wrong, and only the live
// route can say which. Probed underneath the tool, straight at the API.
console.log("\n  the API's own view of the rules:");

async function putRoute(body) {
  const res = await fetch(`${baseUrl}/v1/account/route`, {
    method: "PUT",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({ deal_route: before.deal_route, ...body }),
  });
  let reason;
  if (!res.ok) {
    reason = await res.json().then((b) => b.reason ?? b.title).catch(() => undefined);
  }
  return { status: res.status, reason };
}

const { isValidAgentCardUrl } = await import("../dist/tools-account.js");

const CARD_PROBES = [
  "https://acme.example/.well-known/agent-card.json",
  "https://acme.example/card.json?v=2",
  "https://acme.example/card.json#top",
  "https://acme.example/card/",
  "http://acme.example/card.json",
  "https://localhost/card.json",
  "https://127.0.0.1/card.json",
  "https://192.168.1.1/card.json",
];

for (const url of CARD_PROBES) {
  const mine = isValidAgentCardUrl(url);
  const { status, reason } = await putRoute({ agent_card_url: url });
  const api = status === 204;
  check(
    mine === api,
    `${url} -> tool ${mine ? "accepts" : "refuses"}, API ${status}${reason ? ` ${reason}` : ""}${mine === api ? "" : "  <-- DISAGREEMENT"}`,
  );
}

// An unrecognised binding must be refused by the API, not silently dropped.
const badBinding = await putRoute({ route_protocol_binding: "HTTPS_JSON" });
check(
  badBinding.status === 400,
  `an unrecognised binding is refused by the API: ${badBinding.status}${badBinding.reason ? ` ${badBinding.reason}` : ""}`,
);

// Restore whatever was there to begin with, including nothing.
if (before.route_protocol_binding !== null || before.agent_card_url !== null) {
  await callText("cogdepot_update_profile", {
    contact_name: contact.contact_name,
    contact_email: contact.contact_email,
    deal_route: before.deal_route,
    ...(contact.contact_url ? { contact_url: contact.contact_url } : {}),
    ...(before.route_protocol_binding ? { route_protocol_binding: before.route_protocol_binding } : {}),
    ...(before.agent_card_url ? { agent_card_url: before.agent_card_url } : {}),
  });
}
const restored = await profile();
check(
  restored.route_protocol_binding === before.route_protocol_binding &&
    restored.agent_card_url === before.agent_card_url &&
    restored.deal_route === before.deal_route,
  "the account was restored to the state it was found in",
);

await client.close();

console.log("");
if (failures.length) {
  console.error(`${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log("verify-route: OK - the declaration reaches the live API and reads back.");
