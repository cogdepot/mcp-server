/**
 * The full trading loop, against a real deployment, spending real credits.
 *
 * This is the only thing that exercises the tools which move money. Unit tests
 * mock the transport and `npm run smoke` deliberately refuses to call anything
 * that spends, so until this runs, `cogdepot_finalize_deal` has never seen a
 * real reveal and its renderer is built on a guess about the response shape.
 *
 * It is NOT part of `npm run verify` and never should be. It costs about $2.10
 * per run, seals a real deal between two real accounts, and permanently reveals
 * each to the other. That is a decision a person makes, not something CI does on
 * every push.
 *
 * Negotiation is asymmetric and the roles are not interchangeable. The
 * negotiator opens a thread and makes offers; the poster accepts one by
 * finalizing, and the API enforces that with "only the listing poster may
 * finalize". The negotiator therefore has to make the last offer before the
 * poster can seal, which is why this script counters twice.
 *
 * Requires two funded accounts on the same deployment:
 *
 *   COGDEPOT_E2E_POSTER_KEY      posts the listing, and seals the deal
 *   COGDEPOT_E2E_NEGOTIATOR_KEY  opens the thread and makes the offers
 *   COGDEPOT_API_BASE_URL        must be set, and must not be production
 *   COGDEPOT_E2E_CONFIRM=spend   explicit acknowledgement that this costs money
 *
 * Both accounts need a complete profile (contact details and deal route) or
 * opening a thread fails; the script checks this before spending anything.
 *
 * Everything is driven over real MCP against the built server, one spawned
 * process per account, because the point is to validate the tools and their
 * renderers rather than the API - the API has its own suite.
 */

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const posterKey = process.env.COGDEPOT_E2E_POSTER_KEY;
const negotiatorKey = process.env.COGDEPOT_E2E_NEGOTIATOR_KEY;
const baseUrl = process.env.COGDEPOT_API_BASE_URL;
const confirmed = process.env.COGDEPOT_E2E_CONFIRM === "spend";

const ESTIMATED_COST = [
  "  poster:      201 credits to post, 2,000 at seal        = 2,201 ($1.1005)",
  "  negotiator:  ~2 credits to browse and read, 2,000 held = ~2,002 ($1.001)",
  "  total:       roughly $2.10, non-refundable once sealed",
  "",
  "  The idempotency replay and the balance reads are free: a replay is served",
  "  from the original result, and get_account does not meter. The replay costs",
  "  201 credits in exactly one case - idempotency not being honoured - which",
  "  is the bug it exists to find.",
].join("\n");

function die(message) {
  console.error(`e2e: ${message}`);
  process.exit(1);
}

// --- Refuse to run anywhere dangerous ---------------------------------------
//
// The base URL must be set and must not be production. This is the one check
// worth being obnoxious about: the difference between a staging run and a
// production run is two real strangers being introduced to each other and $2
// gone, and the failure is silent because the script would otherwise "work".

if (!baseUrl) {
  die(
    "COGDEPOT_API_BASE_URL is not set.\n" +
      "This script spends real credits and seals a real deal, so it refuses to guess a target.\n" +
      "Point it at a non-production deployment, e.g. https://staging.api.cogdepot.com",
  );
}

let host;
try {
  host = new URL(baseUrl).hostname.toLowerCase();
} catch {
  die(`COGDEPOT_API_BASE_URL is not a valid URL: ${baseUrl}`);
}

if (host === "api.cogdepot.com" || host === "cogdepot.com") {
  die(
    `refusing to run against production (${host}).\n` +
      "This seals a real deal between two real accounts and reveals each to the other.\n" +
      "If that is genuinely what you want, do it by hand and deliberately, not through a script.",
  );
}

if (!posterKey || !negotiatorKey) {
  die(
    "both COGDEPOT_E2E_POSTER_KEY and COGDEPOT_E2E_NEGOTIATOR_KEY must be set.\n" +
      "Two separate funded accounts are required: an account cannot negotiate with itself.",
  );
}

if (posterKey === negotiatorKey) {
  die("the two keys are identical. cogDepot will reject a thread opened on your own listing.");
}

if (!confirmed) {
  console.error("e2e: this run spends real credits on " + host + ".\n");
  console.error(ESTIMATED_COST + "\n");
  console.error("Set COGDEPOT_E2E_CONFIRM=spend to proceed.");
  process.exit(1);
}

// --- Harness ----------------------------------------------------------------

/** Spawns one server process bound to one account's key. */
async function connect(label, apiKey) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/stdio.js"],
    env: { PATH: process.env.PATH ?? "", COGDEPOT_API_KEY: apiKey, COGDEPOT_API_BASE_URL: baseUrl },
  });
  const client = new Client({ name: `e2e-${label}`, version: "0.0.0" });
  await client.connect(transport);
  return client;
}

let stepNumber = 0;

/**
 * Calls a tool, prints exactly what came back, and fails the run on an error.
 *
 * The printing is not decoration. This script exists to put real responses in
 * front of a human, because the renderers were written against an OpenAPI
 * document and an assumption, and the only way a wrong assumption surfaces is
 * somebody reading the output.
 */
async function call(client, who, name, args = {}) {
  stepNumber += 1;
  console.log(`\n${"=".repeat(72)}`);
  console.log(`[${stepNumber}] ${who}: ${name}`);
  if (Object.keys(args).length > 0) {
    // Truncate the listing body, which is long and not the interesting part.
    const shown = { ...args };
    if (typeof shown.body === "string" && shown.body.length > 80) {
      shown.body = `${shown.body.slice(0, 80)}... (${shown.body.length} chars)`;
    }
    console.log(`    args: ${JSON.stringify(shown)}`);
  }
  console.log("=".repeat(72));

  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((c) => c.text ?? "").join("");
  console.log(text);

  if (result.isError) throw new Error(`${name} failed: ${text}`);
  if (/_micro/.test(text)) throw new Error(`${name} leaked a raw uUSD field name`);
  return text;
}

/**
 * Pulls a value out of a rendered response.
 *
 * The tools return prose rather than JSON, so this parses the same text a model
 * would read. That makes it a real check on the renderers: if an id cannot be
 * found here, a model cannot chain the next call either, and the field is
 * effectively missing however nicely it is formatted.
 */
function field(text, name) {
  const match = new RegExp(`^- \\*\\*${name}\\*\\*: (.+)$`, "m").exec(text);
  return match?.[1]?.trim();
}

/**
 * Reads a credit figure out of a rendered account.
 *
 * The account renderer deliberately never prints a raw micro-USD number, so the
 * only balance available to this script is the human line - "- Spendable:
 * **1,234 credits** ($0.62)". Parsed by splitting rather than by one dense
 * regular expression, because the bold markers differ between the two lines and
 * a pattern covering both is harder to read than it is to get right.
 *
 * Returns undefined rather than 0 when the line is missing: a balance that
 * could not be read must not look like an empty wallet, or every delta
 * assertion below would compare against a number nobody measured.
 */
function credits(text, label) {
  const line = text.split("\n").find((l) => l.startsWith(`- ${label}:`));
  if (!line) return undefined;
  const after = line.replace(/\*/g, "").split(":")[1];
  const n = Number((after ?? "").trim().split(" ")[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function require_(value, what) {
  if (!value) throw new Error(`could not find ${what} in the rendered response`);
  return value;
}

// --- The run ----------------------------------------------------------------

const stamp = new Date().toISOString();
const marker = `[E2E-MCP] ${stamp}`;

let poster;
let negotiator;
/** Set once a thread exists, cleared once it is sealed or closed. */
let openThreadId;
let sealed = false;

try {
  poster = await connect("poster", posterKey);
  negotiator = await connect("negotiator", negotiatorKey);

  console.log(`e2e: running against ${host}`);
  console.log(`e2e: marker ${marker}`);

  // 1-2. Both accounts must be funded and set up before anything is spent.
  // Opening a thread on an incomplete profile fails with 428 after the poster
  // has already paid to list, so this is checked first on both sides.
  const posterAccount = await call(poster, "poster", "cogdepot_get_account");
  const negotiatorAccount = await call(negotiator, "negotiator", "cogdepot_get_account");

  for (const [who, text] of [
    ["poster", posterAccount],
    ["negotiator", negotiatorAccount],
  ]) {
    if (/not set up|profile_incomplete/i.test(text)) {
      throw new Error(`${who}'s profile is incomplete; run cogdepot_update_profile first`);
    }
  }

  const posterOpening = credits(posterAccount, "Spendable");
  const negotiatorOpening = credits(negotiatorAccount, "Spendable");

  // 3. Post the listing. 201 credits.
  //
  // The key is supplied rather than generated inside the tool, because step 3b
  // has to replay this exact call.
  const listingArgs = {
    title: `${marker} end-to-end`,
    category: "testing_qa",
    listing_type: "sell",
    price_usd: 0.5,
    body:
      `Automated end-to-end verification of the cogDepot MCP server, created ${stamp}.\n\n` +
      "This listing exists to exercise the full trading loop and carries no real offer. " +
      "It is expected to be sealed by the paired negotiator account within seconds.",
    delivery_deadline_days: 7,
    idempotency_key: `e2e-post-${stamp}`,
  };
  const posted = await call(poster, "poster", "cogdepot_post_listing", listingArgs);
  const listingId = require_(field(posted, "id"), "the new listing's id");

  // 3b. Replay the identical call with the identical key.
  //
  // spending.test.ts already proves the tool SENDS an Idempotency-Key and hands
  // it back. What no test could reach from inside this repository is whether the
  // API honours it, and that is the single assertion standing between an
  // ambiguous outcome - a timeout, a dropped connection, a retrying agent - and
  // paying to post the same listing twice.
  //
  // This costs nothing when it works, because a replay is served from the
  // original result. It costs 201 credits exactly when it is broken, which is
  // the case worth 201 credits to discover here rather than in front of a user.
  const replayed = await call(poster, "poster", "cogdepot_post_listing", listingArgs);
  const replayedId = field(replayed, "id");
  if (replayedId !== listingId) {
    throw new Error(
      `idempotency is not honoured: replaying the same idempotency_key created ${replayedId} ` +
        `instead of replaying ${listingId}. A retrying agent would pay to post twice.`,
    );
  }

  const posterAfterPost = credits(
    await call(poster, "poster", "cogdepot_get_account"),
    "Spendable",
  );
  if (posterOpening !== undefined && posterAfterPost !== undefined) {
    const spent = posterOpening - posterAfterPost;
    console.log(`e2e: posting cost ${spent} credits across two identical calls`);
    if (spent > 400) {
      throw new Error(
        `the replayed post was charged: ${spent} credits left the poster across two calls with ` +
          "one idempotency key, which is about twice the price of a single listing.",
      );
    }
  }

  // 4. The negotiator finds it through the paid feed, which is the tool that
  // can actually search. Filtering by category keeps the page small.
  const feed = await call(negotiator, "negotiator", "cogdepot_browse_feed", {
    category: "testing_qa",
    type: "sell",
    limit: 20,
  });
  if (!feed.includes(listingId)) {
    console.warn(
      `\ne2e: WARNING - the new listing ${listingId} is not on the first page of the feed. ` +
        "Indexing may lag, or the feed may exclude something. Continuing with the id directly.",
    );
  }

  // 5. Read it in full. 1 credit. This is the renderer that has to cope with a
  // 10,000-character markdown body and the poster's reputation facet.
  await call(negotiator, "negotiator", "cogdepot_get_listing", { listing_id: listingId });

  // 6. Open the negotiation. 2,000 credits held from here until sealed or closed.
  const opened = await call(negotiator, "negotiator", "cogdepot_open_thread", {
    listing_id: listingId,
    diff: "Accepting the listed terms at $0.50 with the 7-day window. Ready to proceed.",
  });
  openThreadId = require_(field(opened, "id"), "the new thread's id");

  // 6b. The hold has to be real, and visible, before anything relies on it.
  //
  // Everything after this point assumes 2,000 credits are in escrow: the
  // refusal check below asserts they are not touched, and the cleanup path
  // exists solely to give them back. If the hold were never placed, all of that
  // would pass while asserting nothing.
  const negotiatorHeld = credits(
    await call(negotiator, "negotiator", "cogdepot_get_account"),
    "Held in escrow",
  );
  if (negotiatorHeld !== undefined && negotiatorHeld < 2000) {
    throw new Error(
      `opening the thread held ${negotiatorHeld} credits, not the 2,000 the documents promise. ` +
        "Either the hold was not placed or it is not being reported.",
    );
  }

  // 7. The poster sees it arrive in their inbox. Free.
  const inbox = await call(poster, "poster", "cogdepot_list_listing_threads", {
    listing_id: listingId,
  });
  if (!inbox.includes(openThreadId)) {
    console.warn(`\ne2e: WARNING - thread ${openThreadId} is missing from the poster's inbox.`);
  }

  // 8. The poster reads the thread and counters. Both free.
  await call(poster, "poster", "cogdepot_get_thread", { thread_id: openThreadId });
  await call(poster, "poster", "cogdepot_submit_offer", {
    thread_id: openThreadId,
    diff: "Confirmed at $0.50 with the 7-day window. These are the final terms.",
  });

  // 9. The negotiator restates the terms as their own standing offer.
  //
  // Not a formality. Finalize is poster-only and accepts the NEGOTIATOR's
  // standing offer, so a poster whose own counter is standing has nothing it is
  // allowed to accept. The negotiator has to speak last for the deal to be
  // sealable at all.
  await call(negotiator, "negotiator", "cogdepot_get_thread", { thread_id: openThreadId });
  await call(negotiator, "negotiator", "cogdepot_submit_offer", {
    thread_id: openThreadId,
    diff: "Agreed: $0.50 with the 7-day window. Offer stands for acceptance.",
  });

  // 9b. Finalize is poster-only, and being refused must cost nothing.
  //
  // Poster-only since 2026-08-01. A refusal that charged anyway would be the
  // worst shape this API could take: the caller is told no and pays 2,000
  // credits for the privilege, on the one call that cannot be undone.
  //
  // If this ever SUCCEEDS the deal has been sealed by the wrong party. The run
  // records that and stops rather than letting the poster finalize a second
  // time - the money is gone either way at that point, a double seal need not
  // be.
  const negotiatorBeforeRefusal = credits(
    await call(negotiator, "negotiator", "cogdepot_get_account"),
    "Spendable",
  );
  console.log(`\n${"=".repeat(72)}`);
  console.log("[guard] negotiator: cogdepot_finalize_deal (must be refused)");
  console.log("=".repeat(72));
  const refusal = await negotiator.callTool({
    name: "cogdepot_finalize_deal",
    arguments: { thread_id: openThreadId },
  });
  const refusalText = (refusal.content ?? []).map((c) => c.text ?? "").join("");
  console.log(refusalText);

  if (!refusal.isError) {
    sealed = true;
    openThreadId = undefined;
    throw new Error(
      "finalize_deal is NOT poster-only: the negotiator sealed the deal. Only the " +
        "listing poster is supposed to be able to, and the deal is now sealed regardless.",
    );
  }

  const negotiatorAfterRefusal = credits(
    await call(negotiator, "negotiator", "cogdepot_get_account"),
    "Spendable",
  );
  if (
    negotiatorBeforeRefusal !== undefined &&
    negotiatorAfterRefusal !== undefined &&
    negotiatorAfterRefusal !== negotiatorBeforeRefusal
  ) {
    throw new Error(
      `the refused finalize charged the negotiator ${negotiatorBeforeRefusal - negotiatorAfterRefusal} ` +
        "credits. Being told no has to be free.",
    );
  }

  // 10. The POSTER seals it - the API enforces "only the listing poster may
  // finalize" with a 403. 2,000 credits from each side, irreversible, and the
  // reveal comes back attached to this response.
  await call(poster, "poster", "cogdepot_get_thread", { thread_id: openThreadId });
  const dealText = await call(poster, "poster", "cogdepot_finalize_deal", {
    thread_id: openThreadId,
  });
  sealed = true;
  openThreadId = undefined;
  const dealId = require_(field(dealText, "id"), "the sealed deal's id");

  // 11. Both sides read the deal. The poster's copy is the one that proves the
  // reveal reached the side that never called finalize.
  await call(poster, "poster", "cogdepot_get_deal", { deal_id: dealId });
  await call(negotiator, "negotiator", "cogdepot_get_deal", { deal_id: dealId });

  // 12. Rate, closing the loop. Counters only move if a side has paid real
  // money, so on a welcome-credit account these will read as zero - which the
  // account renderer explains rather than leaving as an apparent failure.
  await call(negotiator, "negotiator", "cogdepot_rate_deal", { deal_id: dealId, score: 5, delivered: true });
  await call(poster, "poster", "cogdepot_rate_deal", { deal_id: dealId, score: 5, delivered: true });

  // 13. Balances after, so the actual spend is visible rather than estimated.
  await call(poster, "poster", "cogdepot_get_account");
  await call(negotiator, "negotiator", "cogdepot_get_account");

  console.log(`\n${"=".repeat(72)}`);
  console.log("e2e: OK - the full loop ran: post, browse, read, negotiate, seal, rate.");
  console.log(`e2e: listing ${listingId}`);
  console.log(`e2e: deal    ${dealId}`);
  console.log("e2e: the deal record and its reveal are purged 7 days from now.");
} catch (error) {
  console.error(`\n${"=".repeat(72)}`);
  console.error(`e2e: FAILED - ${error instanceof Error ? error.message : String(error)}`);

  // Release the escrow hold rather than leaving 2,000 credits stranded until
  // the thread expires. Only meaningful if the run died between opening and
  // sealing; a sealed deal cannot and must not be closed.
  if (openThreadId && !sealed && negotiator) {
    console.error(`e2e: closing thread ${openThreadId} to release the 2,000-credit hold`);
    try {
      const result = await negotiator.callTool({
        name: "cogdepot_close_thread",
        arguments: { thread_id: openThreadId },
      });
      const text = (result.content ?? []).map((c) => c.text ?? "").join("");
      console.error(result.isError ? `e2e: close FAILED - ${text}` : "e2e: hold released");
    } catch (closeError) {
      console.error(
        `e2e: could not close the thread - ${closeError instanceof Error ? closeError.message : closeError}\n` +
          `e2e: close it manually or the hold sits until the thread expires: ${openThreadId}`,
      );
    }
  }
  process.exitCode = 1;
} finally {
  await poster?.close().catch(() => {});
  await negotiator?.close().catch(() => {});
}
