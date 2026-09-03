/**
 * Drift guard.
 *
 * Fails when cogDepot grows an agent-facing endpoint that no tool covers and
 * that nobody has explicitly decided to leave out. It reads the LIVE
 * /openapi.json, not a checked-in copy, because a checked-in copy drifts in
 * exactly the way this exists to detect.
 *
 * Deliberately NOT keyed off the A2A agent card. The earlier plan proposed that
 * on the basis that the card's `skills` array was the curated tool list; the
 * card has since been reduced to a single `onboarding` skill and a test
 * enforces it, so the card can no longer answer this question.
 *
 * Every path is either covered by a tool or listed with a reason. Adding a new
 * endpoint to the API therefore breaks this build until someone decides which
 * it is - which is the entire point.
 */

const OPENAPI_URL = "https://api.cogdepot.com/openapi.json";

/** Agent-facing paths a shipped tool already covers. */
const COVERED = {
  "GET /v1/account": "cogdepot_get_account",
  "GET /v1/account/profile": "cogdepot_get_account",
  "PUT /v1/account/contact": "cogdepot_update_profile",
  "PUT /v1/account/route": "cogdepot_update_profile",
  "GET /v1/account/domain": "cogdepot_get_domain_challenge",
  "POST /v1/account/domain/verify": "cogdepot_verify_domain",
  "GET /v1/threads/{id}": "cogdepot_get_thread",
  "GET /v1/deals/{id}": "cogdepot_get_deal",
  "POST /v1/deals/{id}/ratings": "cogdepot_rate_deal",
  // Listed BEFORE the API publishes it, deliberately. Until the reputation
  // endpoints deploy, this entry trips the stale check below - which warns
  // and does not fail, so the signal is visible without blocking a release.
  // The alternative was to add it after deploy, which means the first run
  // against the new spec fails as an UNCOVERED path instead: a louder error
  // for the same fact, arriving when nobody is looking for it. A warning that
  // clears itself the day the API ships is the better trade.
  "GET /v1/reputation/{handle}": "cogdepot_get_reputation",
  "GET /stats.json": "cogdepot_get_stats",

  "GET /v1/feed": "cogdepot_browse_feed",
  "GET /v1/listings/{id}": "cogdepot_get_listing",
  "POST /v1/listings": "cogdepot_post_listing",
  "GET /v1/listings/{id}/threads": "cogdepot_list_listing_threads",
  "POST /v1/listings/{id}/threads": "cogdepot_open_thread",
  "POST /v1/threads/{id}/offers": "cogdepot_submit_offer",
  "POST /v1/threads/{id}/close": "cogdepot_close_thread",
  "POST /v1/threads/{id}/finalize": "cogdepot_finalize_deal",
  // Note: GET /v1/listings/mine is NOT listed here, though cogdepot_get_my_listings
  // covers it. Like POST /v1/account/web below, it is a real route the published
  // OpenAPI omits - unauthenticated it answers 401, exactly as /v1/account does,
  // where a path that does not exist answers 404. Listing it would trip the stale
  // check on every run, so the tool is real and this guard cannot see it. If the
  // API ever publishes the route, move it up here.
};

/** Paths deliberately not exposed, each with the decision behind it. */
const EXCLUDED = {
  "POST /v1/account/register":
    "Sends accepted_terms: true. A tool must not accept a legal agreement unattended; cogdepot_get_started explains the route instead.",

  // Listed BEFORE the API publishes it, on the same reasoning as the reputation
  // entry in COVERED: a stale-entry warning that clears itself on deploy beats an
  // UNCOVERED failure arriving when nobody is watching for it.
  "POST /v1/deals/{id}/dispute":
    "Files a claim against a counterparty of a sealed deal. Excluded on the same " +
    "reasoning as register_account, not because it spends: it is an ACCUSATION that " +
    "permanently marks another party's public reputation record, the server " +
    "adjudicates nothing, and there is no route to withdraw it. An agent that " +
    "misreads a delivery could mark an honest counterparty forever, and the harm " +
    "lands on someone who is not the caller and never consented. cogdepot_get_reputation " +
    "surfaces the dispute counters so a model can still REASON about disputes; filing " +
    "one is a step a person should take. Revisit if a withdrawal route or an " +
    "adjudication step ever exists.",

  "POST /v1/account/reputation/attestation":
    "Mints a 24-hour PASETO attesting the CALLER'S OWN record - a credential, not a fact. " +
    "What a model can act on is already covered: cogdepot_get_reputation reads any handle's " +
    "record live, free and keyless, and a counterparty checking a record should read it from " +
    "cogDepot rather than trust a token the assessed party handed over. Shipping a tool for " +
    "the self-minted version would advertise the weaker path as the normal one. The token " +
    "exists for OFFLINE verification against the key at /.well-known/paseto-keys.json by a " +
    "party that cannot call the API, which is never the situation an MCP tool is in.",

  "GET /.well-known/jwks.json":
    "JWK Set carrying the public half of the Agent Card signing key. Key material for " +
    "verifying a signature offline, not a fact about the market - there is nothing here " +
    "a model could act on, and a party that can call the API has no reason to fetch it.",
  "GET /.well-known/paseto-keys.json":
    "PASETO v4.public verification keys for reputation attestations and deal credentials. " +
    "Excluded on the reasoning already written against POST /v1/account/reputation/attestation: " +
    "these keys exist for OFFLINE verification by a party that cannot call the API, which is " +
    "never the situation an MCP tool is in.",
  "GET /.well-known/agent-card.json": "Discovery document, summarised by cogdepot_discover.",
  "GET /.well-known/ai-catalog.json": "Discovery document, not separately useful to a model.",
  "GET /.well-known/cogdepot.json": "Read directly as the live-facts source.",
  "GET /.well-known/x402": "Crypto payment manifest. Deliberately never surfaced.",
  "GET /.well-known/security.txt": "Security-contact file (RFC 9116), not agent-facing.",
  "GET /openapi.json": "Read by this guard, not by a tool.",
  "GET /llms-full.txt": "Prose index, redundant with cogdepot_discover.",
  "GET /robots.txt": "Not agent-facing.",
  "GET /health": "Operational, not agent-facing.",
  "GET /version": "Operational, not agent-facing.",
  "GET /status.json": "Statuspage uptime feed (all-systems status, component history), not agent-facing.",
  "POST /a2a": "A2A JSON-RPC surface. A different protocol, not wrapped by MCP.",

  "POST /dashboard/credits": "Top-up. Moves money; barred from directory listing outright.",
  "POST /dashboard/keys": "Operator dashboard, not agent-facing.",
  "POST /dashboard/keys/rotate": "Operator dashboard, not agent-facing.",
  "PUT /dashboard/contact": "Operator dashboard; the agent twin is /v1/account/contact.",
  "PUT /dashboard/route": "Operator dashboard; the agent twin is /v1/account/route.",
  "POST /webhooks/blockbee": "Payment webhook. Called by the provider, never by a client.",
  "POST /webhooks/opennode": "Payment webhook. Called by the provider, never by a client.",
  // Note: POST /v1/account/web is NOT listed here. It exists in the API's
  // router but is deliberately absent from the published OpenAPI - the route
  // list is hand-curated, and several registered routes are omitted on purpose.
  // Listing it would make this file claim to reason about an operation the
  // spec never offers, which is the stale-entry warning below.
};

// Cross-check the other direction first: every tool this file claims covers an
// endpoint must actually be registered. Without this the guard is half a guard -
// it notices the API growing, but deleting a tool would leave COVERED asserting
// a name that no longer exists and the check would still pass.
// Asked over the real protocol rather than by reading an SDK internal: an
// underscore-prefixed field is not a contract, and a check that breaks on an
// SDK upgrade is a check that gets disabled.
const { buildServer } = await import("../dist/core.js");
const { Client } = await import("@modelcontextprotocol/client");
const { InMemoryTransport } = await import("@modelcontextprotocol/server");

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const driftClient = new Client({ name: "drift", version: "0.0.0" });
await Promise.all([
  buildServer("drift-check-not-a-real-key").connect(serverTransport),
  driftClient.connect(clientTransport),
]);
const { tools } = await driftClient.listTools();
await driftClient.close();

const registered = new Set(tools.map((t) => t.name));

if (registered.size === 0) {
  console.error("drift: the server registered no tools - is dist/ built?");
  process.exit(1);
}

const missingTools = [...new Set(Object.values(COVERED))].filter((t) => !registered.has(t));
if (missingTools.length > 0) {
  console.error("drift: COVERED names tools that are not registered:");
  for (const t of missingTools) console.error(`  - ${t}`);
  console.error("");
  console.error("Either the tool was removed and this file was not updated, or it was renamed.");
  process.exit(1);
}
console.log(`drift: ${registered.size} tools registered, all names in COVERED resolve`);

// An unreachable spec is "could not check", not "a claim is false", and the
// difference is the whole usefulness of this guard. On 2026-08-22 a production
// edge cutover left /openapi.json 404 for a few minutes and this exited 1,
// failing a build over a change that touched only a workflow file. A guard that
// reports someone's code as broken because a deploy was mid-flight is a guard
// people learn to re-run without reading.
//
// Exit 2 says so out loud, matching web/scripts/mcp-drift.mjs, and matching what
// this same file already does a few lines below when the discovery document is
// unreachable: warn, skip, call it unknown rather than stale.
let response;
try {
  response = await fetch(OPENAPI_URL, { headers: { accept: "application/json" } });
} catch (err) {
  console.error(`drift: could not reach ${OPENAPI_URL}: ${err.message}`);
  console.error("drift: SKIPPED - the spec was unreachable, so nothing was proven either way.");
  process.exit(2);
}
if (!response.ok) {
  console.error(`drift: could not fetch ${OPENAPI_URL} (HTTP ${response.status})`);
  console.error("drift: SKIPPED - the spec was unreachable, so nothing was proven either way.");
  console.error("drift: if this persists, the machine contract itself is down, which is the real problem.");
  process.exit(2);
}
const spec = await response.json();

const live = [];
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  for (const method of Object.keys(item)) {
    if (["get", "post", "put", "patch", "delete"].includes(method)) {
      live.push(`${method.toUpperCase()} ${path}`);
    }
  }
}

const undecided = live.filter((op) => !(op in COVERED) && !(op in EXCLUDED));
const stale = [...Object.keys(COVERED), ...Object.keys(EXCLUDED)].filter((op) => !live.includes(op));

console.log(`drift: ${live.length} operations live, ${Object.keys(COVERED).length} covered by tools`);

if (stale.length > 0) {
  // Not fatal on its own: an endpoint being retired is fine, but a stale entry
  // means this file claims to reason about something that no longer exists.
  console.warn(`drift: ${stale.length} entr(ies) reference operations no longer in the spec:`);
  for (const op of stale) console.warn(`  - ${op}`);
}

if (undecided.length > 0) {
  console.error("");
  console.error("drift: the API has operations this server neither covers nor excludes:");
  for (const op of undecided) console.error(`  - ${op}`);
  console.error("");
  console.error("Add each to COVERED with the tool that handles it, or to EXCLUDED with the");
  console.error("reason it is deliberately absent. Silence is not a decision.");
  process.exit(1);
}

console.log("drift: OK - every live operation is either covered or explicitly excluded");

// --- the bundled snapshot ---------------------------------------------------
// src/facts-snapshot.json is the fallback served when the live document cannot
// be reached, and it is frozen at whatever moment somebody last ran a fetch.
// Nothing else notices it going stale, so a release months from now would ship
// months-old prices as its fallback and label them merely "not live".
//
// Only the credits block is compared. The rest of the document carries long
// prose that gets reworded without changing any fact, and a guard that cries
// wolf on a copy edit is a guard that gets bypassed. Prices are the part where
// stale means wrong.
const { readFileSync } = await import("node:fs");
const snapshot = JSON.parse(readFileSync("src/facts-snapshot.json", "utf8"));

const discoveryResponse = await fetch("https://api.cogdepot.com/.well-known/cogdepot.json", {
  headers: { accept: "application/json" },
});
if (!discoveryResponse.ok) {
  console.warn(`drift: could not fetch the discovery document (HTTP ${discoveryResponse.status})`);
  console.warn("drift: skipping the snapshot freshness check - unknown, not stale");
} else {
  const liveDoc = await discoveryResponse.json();

  // The keyless preview lives on the STOREFRONT (cogdepot.com), not the API, so
  // it is absent from the OpenAPI document checked above and nothing up there
  // can notice it moving or disappearing. cogdepot_preview_listings resolves it
  // from this field at call time, so the field going missing silently demotes
  // the tool to a hard-coded URL, and the field going off-domain makes the tool
  // refuse outright. Both are worth failing a build over.
  const previewUrl = liveDoc.keylessPreview?.url;
  if (typeof previewUrl !== "string" || previewUrl.length === 0) {
    console.error("");
    console.error("drift: the discovery document no longer states keylessPreview.url.");
    console.error("cogdepot_preview_listings would fall back to its built-in URL. Confirm the");
    console.error("endpoint still exists, then update DEFAULT_PREVIEW_URL in src/strings.js.");
    process.exit(1);
  }
  const previewHost = new URL(previewUrl).hostname.toLowerCase();
  if (previewHost !== "cogdepot.com" && !previewHost.endsWith(".cogdepot.com")) {
    console.error("");
    console.error(`drift: keylessPreview.url points off-domain (${previewHost}).`);
    console.error("cogdepot_preview_listings refuses to call it, so the tool is dead until this");
    console.error("is explained. Treat a surprise here as a possible tampered document.");
    process.exit(1);
  }
  console.log(`drift: OK - the keyless preview is still advertised at ${previewUrl}`);

  const snapCredits = JSON.stringify(snapshot.credits ?? {});
  const liveCredits = JSON.stringify(liveDoc.credits ?? {});

  if (snapCredits !== liveCredits) {
    console.error("");
    console.error("drift: the bundled snapshot's pricing no longer matches the live document.");
    console.error("Refresh it before releasing:");
    console.error(
      "  curl -s https://api.cogdepot.com/.well-known/cogdepot.json -o src/facts-snapshot.json",
    );
    process.exit(1);
  }
  console.log("drift: OK - the bundled snapshot's pricing matches the live document");
}

// --- the deployed remote server ---------------------------------------------
// The hosted server is the one surface nothing in this repository deploys.
// publish.yml ships the npm package and the registry entry from a tag; the
// Lambda is updated by hand (see "Deploying the remote server" in README.md).
//
// That gap is not theoretical. The deployment served 0.3.0 for six days while
// npm served 0.4.0 - two releases of tool descriptions that no connector user
// ever saw - and nothing anywhere went red, because nothing was looking.
//
// The comparison is against what npm SERVES, not against package.json. A version
// bumped locally and not yet released is the normal state of a release branch,
// and a guard that fires on it would be noise on every release PR. A published
// version the deployment does not answer with is the actual defect.
//
// A warning, not a failure. This runs on paths where a stale deployment is not
// the caller's problem in that moment - an unrelated PR, the pre-publish check
// on a tag - and a red that blocks work nobody can act on is a red that gets
// bypassed. A warning printed on every run until somebody deploys is the louder
// instrument here.
const REMOTE_MCP_URL = "https://mcp.cogdepot.com";

// Shared with assert-deployed-version.mjs, which deploy.yml runs against the tag
// it just shipped. Two inline copies of one request is how the release gate and
// this guard would come to disagree about what "deployed" means.
const { deployedVersion } = await import("./deployed-version.mjs");

try {
  const [deployed, registry] = await Promise.all([
    deployedVersion(REMOTE_MCP_URL),
    fetch("https://registry.npmjs.org/@cogdepot/mcp-server/latest", {
      headers: { accept: "application/json" },
    }).then((response) => (response.ok ? response.json() : null)),
  ]);
  const published = registry?.version ?? null;

  if (!deployed || !published) {
    console.warn("drift: could not reach the deployed server or the npm registry.");
    console.warn("drift: skipping the deployment freshness check - unknown, not stale");
  } else if (deployed !== published) {
    console.warn("");
    console.warn(`drift: WARNING - ${REMOTE_MCP_URL} serves ${deployed}, npm serves ${published}.`);
    console.warn("Connector users reach the DEPLOYED build, so every description corrected since");
    console.warn("then is invisible to them. Nothing in CI deploys the Lambda - follow");
    console.warn("\"Deploying the remote server\" in README.md, then re-run this.");
  } else {
    console.log(`drift: OK - the deployed server and npm both serve ${deployed}`);
  }
} catch (error) {
  console.warn(`drift: the deployment freshness check could not run (${error.message})`);
  console.warn("drift: skipping - unknown, not stale");
}
