/**
 * Answers one question: has a deployment shipped the route declaration yet?
 *
 *   node scripts/route-ready.mjs prod
 *   node scripts/route-ready.mjs staging
 *   node scripts/with-keys.mjs prod route-ready    # adds the live profile read
 *
 * READ-ONLY. This never writes, on any environment. It is the gate that
 * verify:route cannot be, because verify:route writes to the account its key
 * owns and so is refused against production - which leaves production, the very
 * deployment the published package points at by default, with nothing checking
 * it at all.
 *
 * That gap is the reason this exists. `DEFAULT_API_BASE_URL` is
 * https://api.cogdepot.com, so a release ships a tool aimed at production. If
 * production has not deployed the declaration, the API ignores the unknown
 * fields, answers 204, and cogdepot_update_profile reports a binding that was
 * never stored. A green staging run says nothing about that.
 *
 * Exit codes: 0 the deployment is ready, 1 it is not, 2 the check could not be
 * completed. A deployment that is not ready and a check that could not run are
 * different answers and are never collapsed into one.
 */

const ENVIRONMENTS = {
  prod: "https://api.cogdepot.com",
  staging: "https://staging.api.cogdepot.com",
};

/** The three bindings an operator may declare, in the order the API lists them. */
const EXPECTED_BINDINGS = ["JSONRPC", "HTTP+JSON", "https://cogdepot.com/bindings/webhook-v1"];

const named = process.argv[2];
if (named && !ENVIRONMENTS[named]) {
  console.error(`route-ready: unknown environment "${named}". Expected one of: ${Object.keys(ENVIRONMENTS).join(", ")}`);
  process.exit(2);
}
// An explicit name wins, then whatever with-keys.mjs exported, then production -
// the default the published package itself uses, so the bare command answers the
// question that actually blocks a release.
const baseUrl = named ? ENVIRONMENTS[named] : (process.env.COGDEPOT_API_BASE_URL ?? ENVIRONMENTS.prod);

const missing = [];
const notes = [];

function check(ok, message) {
  console.log(`  ${ok ? "ok  " : "MISSING"}  ${message}`);
  if (!ok) missing.push(message);
}

console.log(`\nroute-ready: ${baseUrl}\n`);

let spec;
try {
  const res = await fetch(`${baseUrl}/openapi.json`);
  if (!res.ok) {
    console.error(`route-ready: ${baseUrl}/openapi.json answered ${res.status}. Nothing was proven either way.`);
    process.exit(2);
  }
  spec = await res.json();
} catch (err) {
  console.error(`route-ready: could not reach ${baseUrl}: ${err.message}. Nothing was proven either way.`);
  process.exit(2);
}

const schemas = spec.components?.schemas ?? {};

// Gate 1: the write side accepts both fields, and deal_route is still the only
// required one. A required list that grew would break every existing caller.
const routeRequest = schemas.SetSelfRouteRequest?.properties ?? {};
check("route_protocol_binding" in routeRequest, "SetSelfRouteRequest accepts route_protocol_binding");
check("agent_card_url" in routeRequest, "SetSelfRouteRequest accepts agent_card_url");

const required = schemas.SetSelfRouteRequest?.required ?? [];
check(
  required.length === 1 && required[0] === "deal_route",
  `SetSelfRouteRequest still requires deal_route alone (got ${JSON.stringify(required)})`,
);

const binding = routeRequest.route_protocol_binding?.enum;
check(
  Array.isArray(binding) && JSON.stringify(binding) === JSON.stringify(EXPECTED_BINDINGS),
  `the binding enum is the three the tool offers (got ${JSON.stringify(binding ?? null)})`,
);

// Gate 2: the read side echoes both, which is what makes a declaration
// verifiable by whoever made it.
const profile = schemas.AccountProfile?.properties ?? {};
check("route_protocol_binding" in profile, "AccountProfile echoes route_protocol_binding");
check("agent_card_url" in profile, "AccountProfile echoes agent_card_url");

// Gate 3: the reveal carries what cogdepot_get_deal's description promises.
const reveal = schemas.DealReveal?.properties ?? {};
check("counterparty_agent_card_url" in reveal, "DealReveal carries counterparty_agent_card_url");
const revealBinding = reveal.counterparty_interface?.properties?.protocolBinding?.enum;
check(
  Array.isArray(revealBinding) && JSON.stringify(revealBinding) === JSON.stringify(EXPECTED_BINDINGS),
  `the reveal's binding enum is operator-declared, not the old HTTPS_JSON (got ${JSON.stringify(revealBinding ?? null)})`,
);

// Optional, and the only part that reads the deployment rather than its own
// description of itself. A spec is generated; a response is served. When a key
// is available, prefer the response.
const apiKey = process.env.COGDEPOT_API_KEY;
if (apiKey) {
  try {
    const res = await fetch(`${baseUrl}/v1/account/profile`, { headers: { "x-api-key": apiKey } });
    if (res.ok) {
      const live = await res.json();
      check(
        "route_protocol_binding" in live && "agent_card_url" in live,
        "the LIVE profile response carries both keys, not just the spec",
      );
    } else {
      console.log(`  SKIP    GET /v1/account/profile answered ${res.status}`);
      notes.push("the live profile could not be read");
    }
  } catch (err) {
    console.log(`  SKIP    could not read the live profile: ${err.message}`);
    notes.push("the live profile could not be read");
  }
} else {
  console.log("  SKIP    no COGDEPOT_API_KEY, so only the published spec was checked");
  notes.push("the live profile was not read");
}

console.log("");
if (missing.length) {
  console.error(
    `${baseUrl} has NOT deployed the route declaration: ${missing.length} thing(s) missing.\n` +
      "Releasing against this would ship a tool whose writes are silently discarded - the API\n" +
      "ignores unknown JSON fields, so the declaration would be dropped and reported as saved.",
  );
  process.exit(1);
}
if (notes.length) {
  console.log(`route-ready: the published spec is ready. Not fully proven: ${notes.join("; ")}.`);
  process.exit(0);
}
console.log("route-ready: OK - this deployment accepts, echoes and reveals the route declaration.");
