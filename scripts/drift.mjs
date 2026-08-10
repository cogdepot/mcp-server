/**
 * Drift guard.
 *
 * Fails when cogDepot grows an agent-facing endpoint that no tool covers and
 * that nobody has explicitly decided to leave out. It reads the LIVE
 * /openapi.json, not a checked-in copy, because a checked-in copy drifts in
 * exactly the way this exists to detect.
 *
 * Deliberately NOT keyed off the A2A agent card. The earlier plan proposed that
 * on the basis that the card's `skills` array was the curated tool list; T977
 * has since reduced the card to a single `onboarding` skill and a test enforces
 * it, so the card can no longer answer this question.
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
};

/** Paths deliberately not exposed, each with the decision behind it. */
const EXCLUDED = {
  "POST /v1/account/register":
    "Sends accepted_terms: true. A tool must not accept a legal agreement unattended; cogdepot_get_started explains the route instead.",

  "GET /v1/feed": "GATED: 1 credit per call, pending the connector-directory eligibility answer.",
  "GET /v1/listings/{id}": "GATED: 1 credit per call, same question.",
  "POST /v1/listings": "GATED: 200 credits plus the metered call.",
  "POST /v1/listings/{id}/threads": "GATED: places a 2000-credit hold.",
  "POST /v1/threads/{id}/finalize": "GATED: charges 2000 credits per side, irreversible.",
  "POST /v1/threads/{id}/offers": "GATED with the negotiation set; ships with open_thread.",
  "POST /v1/threads/{id}/close": "GATED with the negotiation set.",
  "GET /v1/listings/{id}/threads": "GATED with the negotiation set.",

  "GET /.well-known/agent-card.json": "Discovery document, summarised by cogdepot_discover.",
  "GET /.well-known/ai-catalog.json": "Discovery document, not separately useful to a model.",
  "GET /.well-known/cogdepot.json": "Read directly as the live-facts source.",
  "GET /.well-known/x402": "Crypto payment manifest. Deliberately never surfaced.",
  "GET /openapi.json": "Read by this guard, not by a tool.",
  "GET /llms-full.txt": "Prose index, redundant with cogdepot_discover.",
  "GET /robots.txt": "Not agent-facing.",
  "GET /health": "Operational, not agent-facing.",
  "GET /version": "Operational, not agent-facing.",
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

const response = await fetch(OPENAPI_URL, { headers: { accept: "application/json" } });
if (!response.ok) {
  console.error(`drift: could not fetch ${OPENAPI_URL} (HTTP ${response.status})`);
  process.exit(1);
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
