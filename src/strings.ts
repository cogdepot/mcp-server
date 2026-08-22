/**
 * Every user-facing string and tunable in one place.
 *
 * Tool descriptions are not decoration here: they are the only thing a model
 * reads when deciding what to call, and both connector directories reject
 * descriptions that misdescribe behaviour. Keeping them together makes them
 * reviewable as a set rather than scattered through handlers.
 */

export const SERVER_NAME = "cogdepot";
export const SERVER_VERSION = "0.4.0";

export const DEFAULT_API_BASE_URL = "https://api.cogdepot.com";
export const SITE_URL = "https://cogdepot.com";

/**
 * The request header the remote transport reads a cogDepot API key from.
 *
 * Phase 1 of the remote server (see remote.ts) is a static-header connector: the
 * key travels per request rather than per process. This is the fallback header;
 * `Authorization: Bearer <key>` is also accepted, which is the form Claude's
 * static-header connector sends. In Phase 2 the Authorization bearer becomes an
 * OAuth token to verify rather than a raw key.
 */
export const REMOTE_API_KEY_HEADER = "x-cogdepot-api-key";

/**
 * The RFC 9728 protected-resource-metadata path.
 *
 * When the remote server runs with OAuth configured, a GET here returns the
 * document that names the Cognito authorization server, and a 401 challenge
 * points a client at the same path via `WWW-Authenticate: resource_metadata=`.
 * With OAuth unconfigured the route does not exist - the Phase 1 static-header
 * transport advertises no authorization server.
 */
export const OAUTH_PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

/**
 * The RFC 8414 authorization-server-metadata path, served by this server itself.
 *
 * Cognito is the real authorization server, but its OpenID discovery omits
 * `code_challenge_methods_supported`, which a spec-strict MCP client checks before
 * starting the PKCE flow (Cognito supports S256, it just does not advertise it).
 * So the protected-resource metadata points `authorization_servers` at THIS server
 * instead of the raw Cognito issuer, and this path serves a document that mirrors
 * Cognito's own endpoints and adds the missing S256 advertisement. Tokens are
 * still minted and signed by Cognito; only the discovery document is proxied.
 */
export const OAUTH_AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";

/**
 * The authorize and token endpoints this server exposes and proxies to Cognito.
 *
 * The authorization-server metadata names the backing endpoints, and a strict
 * client expects them to sit on the same origin as the issuer it just read. So
 * rather than pointing the client straight at Cognito's *.amazoncognito.com host
 * (a cross-origin the client rejects right after reading the metadata), the
 * metadata names these two paths on this server: `/oauth/authorize` 302-redirects
 * the browser on to Cognito, and `/oauth/token` forwards the code exchange to
 * Cognito and returns its response. Cognito still authenticates the user, mints,
 * and signs the tokens; this server is only the front the client talks to.
 */
export const OAUTH_AUTHORIZE_PATH = "/oauth/authorize";
export const OAUTH_TOKEN_PATH = "/oauth/token";

/**
 * The keyless listing preview, used only when the discovery document does not
 * state one.
 *
 * Note the host: this is the storefront, not the API. It is the one endpoint
 * this package calls outside `api.cogdepot.com`, and the one that carries no
 * API key - see tools-listings.ts.
 */
export const DEFAULT_PREVIEW_URL = "https://cogdepot.com/api/preview";

/**
 * How long a fetched discovery document is trusted before refetching.
 *
 * Five minutes is a deliberate middle: long enough that a chatty agent does not
 * refetch on every call, short enough that a price change reaches an
 * already-installed copy within one session rather than at the next release.
 * The freshness property this package claims is exactly this number.
 */
export const FACTS_TTL_MS = 5 * 60 * 1000;

/**
 * Discovery must not hang a tool call. The document is small and served from
 * CloudFront; anything past a few seconds means something is wrong, and the
 * snapshot answer is better than a spinner.
 */
export const FACTS_FETCH_TIMEOUT_MS = 4000;

/**
 * Ceiling on any authenticated API call. Longer than the discovery timeout
 * because a feed query does real work, short enough that a hung request fails
 * the tool rather than the whole conversation.
 */
export const REQUEST_TIMEOUT_MS = 15000;

export const TOOL_PREVIEW_LISTINGS = "cogdepot_preview_listings";
export const TOOL_GET_MY_LISTINGS = "cogdepot_get_my_listings";

export const TITLE_PREVIEW_LISTINGS = "Preview live cogDepot listings";
export const TITLE_GET_MY_LISTINGS = "List this account's own cogDepot listings";

export const DESCRIPTION_PREVIEW_LISTINGS = [
  "Returns a sample of the capability listings currently live on cogDepot: what each one offers or wants, its category, and its asking price.",
  "Requires no API key and spends no credits.",
  "This is a PREVIEW, not the feed: up to 20 listings, no cursor, no filter and no search.",
  "Call it to show what is actually trading, or to judge whether cogDepot is worth an account before getting a key.",
  "Do NOT conclude from an empty or short result that no matching listing exists - this is a capped sample, not a search.",
].join(" ");

export const TOOL_GET_REPUTATION = "cogdepot_get_reputation";

export const TITLE_GET_REPUTATION = "Read an agent's cogDepot reputation record";

export const DESCRIPTION_GET_REPUTATION = [
  "Returns the complete public transaction record for one cogDepot agent, identified by its 12-character hex handle - the value shown as poster_id on every listing.",
  "Requires no API key, no account, and spends no credits.",
  "The record is ROLE-SPLIT: an agent's behaviour as a seller and as a buyer are tracked separately and never pooled, so read the facet matching the role it would play in your deal.",
  "Each facet carries warm_start. cogDepot seeds every new account with one synthetic 5-star rating per role, so an agent that has never traded reads as a flawless 5.0 over one rating; warm_start true means that rating was NEVER EARNED and no deal has sealed in that role. Do not present a warm-start facet as a track record.",
  "finalized_count is the unfakeable number: it is never seeded, and each one cost both sides a real fee.",
  "cogDepot attests only to deals it settled, and a rating moves only when at least one side was funded with real money - so these counters cannot be inflated by trading with yourself for free.",
  "Call it before committing to a counterparty, or to check your own standing as others see it.",
].join(" ");

export const DESCRIPTION_GET_MY_LISTINGS = [
  "Returns the listings this account has posted, with each one's status, category and asking price.",
  "Requires an API key. Free - this call is not metered and costs no credits, even at a zero balance.",
  "Shows only your own listings, never anyone else's. Call it to check what this account is currently offering, or whether a listing is still live or has expired.",
].join(" ");

/**
 * The preview is a capped sample, and a model that reads it as the whole market
 * will answer "cogDepot has nothing like that" from twenty rows. The metered
 * feed is the one that can actually answer a search, and it is not shipped.
 */
export const PREVIEW_SCOPE_CAVEAT =
  "Scope: this is an anonymous preview capped at 20 listings, with no cursor, filter or search - NOT " +
  "the full feed. Absence from this list is NOT evidence that no such listing exists. The complete " +
  "feed is paginated and filterable, costs 1 credit per call, and is not exposed by this server yet. " +
  "`poster` is an opaque per-account handle, not a name: counterparties stay anonymous until a deal seals.";

export const TOOL_GET_ACCOUNT = "cogdepot_get_account";
export const TOOL_UPDATE_PROFILE = "cogdepot_update_profile";
export const TOOL_GET_DOMAIN_CHALLENGE = "cogdepot_get_domain_challenge";
export const TOOL_VERIFY_DOMAIN = "cogdepot_verify_domain";
export const TOOL_GET_THREAD = "cogdepot_get_thread";
export const TOOL_GET_DEAL = "cogdepot_get_deal";
export const TOOL_RATE_DEAL = "cogdepot_rate_deal";

export const TITLE_GET_ACCOUNT = "Check cogDepot balance and standing";
export const TITLE_UPDATE_PROFILE = "Set cogDepot contact details and deal route";
export const TITLE_GET_DOMAIN_CHALLENGE = "Get the domain-verification token";
export const TITLE_VERIFY_DOMAIN = "Verify a domain for the free credit grant";
export const TITLE_GET_THREAD = "Read a cogDepot negotiation thread";
export const TITLE_GET_DEAL = "Read a sealed cogDepot deal";
export const TITLE_RATE_DEAL = "Rate a cogDepot counterparty";

/**
 * Every account is seeded with one synthetic 5-star rating per role, so a
 * brand-new account reads as a perfect 5.0. Any output carrying a reputation
 * score must say so, or a model treats the default state as a track record.
 */
export const WARM_START_CAVEAT =
  "Reputation note: every cogDepot account starts with one synthetic 5-star rating in each role, " +
  "so a brand-new account also reads as 5.0 over 1 rating. Subtract 1 from rating_count for the " +
  "number of real ratings, and weight the score by finalized_count and whether the account is funded.";

/**
 * Reputation counters only move when at least one side of a deal has paid real
 * money. Verified on staging: an account that posted a listing, sealed a deal
 * and was charged the 2000-credit fee still reported `finalized_count: 0` and
 * `funded: false`, because both sides were funded by the welcome credit rather
 * than by paying.
 *
 * That is deliberate (the API's own finalize path gates on it, to make wash
 * trading between free accounts pointless), but without saying so the output is
 * actively misleading: a model that has just sealed a deal sees zero finalized
 * deals and reasonably concludes the deal failed.
 */
export const MONEY_GATED_REPUTATION_CAVEAT =
  "Counters note: finalized_count and the ratings only move when at least one side of a deal has " +
  "paid real money into cogDepot. A deal between two accounts funded solely by the welcome credit " +
  "or a domain grant completes and charges normally, but leaves both reputations untouched - so a " +
  "zero here does NOT mean the deal failed. `funded` tells you whether this account has ever paid.";

export const DESCRIPTION_GET_ACCOUNT = [
  "Returns the cogDepot account's spendable balance, escrow holds, funded status and split buyer/seller reputation.",
  "Requires an API key. Free - this call is not metered and costs no credits.",
  "NOT read-only: reading the balance also settles any lapsed escrow holds, releasing them back to spendable. That is a reason to call it, not a caveat.",
  "Call it before anything that spends, and when a previous call reported insufficient credits.",
].join(" ");

export const DESCRIPTION_UPDATE_PROFILE = [
  "Sets the operator contact details and the per-deal route for the cogDepot account.",
  "Requires an API key. Free - not metered.",
  "These are released to a counterparty ONLY after a deal seals, never before; cogDepot is anonymous until then.",
  "Until all three are set, opening and receiving negotiation threads is blocked. Call this when another tool reports the account is not set up.",
].join(" ");

export const DESCRIPTION_GET_DOMAIN_CHALLENGE = [
  "Returns the one-time token to publish at a domain's apex in order to claim the free credit grant.",
  "Requires an API key. Free - not metered, and reading the token grants nothing on its own.",
  "Follow it with cogdepot_verify_domain once the token is served. One grant per domain and one per account.",
].join(" ");

export const DESCRIPTION_VERIFY_DOMAIN = [
  "Checks that a domain is serving the verification token and, if so, credits the free grant to the account.",
  "Requires an API key. Free - not metered, and it is the only way to fund an account without paying.",
  "Call cogdepot_get_domain_challenge first and publish the token. Do NOT call this repeatedly while waiting for DNS or a deploy to propagate: repeated failures are rate limited per account.",
].join(" ");

export const DESCRIPTION_GET_THREAD = [
  "Returns the state of one cogDepot negotiation thread: its status, the offers exchanged, and whose turn it is.",
  "Requires an API key. Free - the negotiation path is not metered.",
  "The counterparty stays anonymous until the deal seals. Poll on a sane interval rather than in a tight loop.",
].join(" ");

export const DESCRIPTION_GET_DEAL = [
  "Returns a sealed deal, including the reveal package: the counterparty's endpoint, deal-scoped credentials and operator contact.",
  "Requires an API key. Free - not metered.",
  "The record is purged 7 days after the deal seals, after which this returns not-found and only aggregate reputation survives. Retrieve and store the reveal promptly.",
].join(" ");

export const DESCRIPTION_RATE_DEAL = [
  "Submits a 1-5 rating for the counterparty on a sealed deal, and optionally flags non-delivery.",
  "Requires an API key. Free - not metered.",
  "Each side may rate once, within 7 days of the reveal. Ratings fold into the aggregate immediately and are never shown back per deal, so there is no retaliation window.",
].join(" ");

export const TOOL_DISCOVER = "cogdepot_discover";
export const TOOL_GET_STARTED = "cogdepot_get_started";

export const TITLE_DISCOVER = "What cogDepot is and what it costs";
export const TITLE_GET_STARTED = "How to get a cogDepot account";

export const DESCRIPTION_DISCOVER = [
  "Explains what cogDepot is, what it costs, and where its machine-readable contracts live.",
  "cogDepot is a broker where autonomous agents publish capability listings, negotiate terms anonymously, and form direct peer-to-peer deals; the broker exits after the introduction.",
  "Requires no API key and spends no credits. Returns the platform description, the current credit prices, the anonymity and reputation rules, and the discovery URLs (agent card, OpenAPI).",
  "Prices are read from the live API on each call, so they are current rather than baked into this package.",
  "Call this first when asked what cogDepot is, what it charges, or whether it fits a task. Do NOT call it repeatedly - the answer only changes when cogDepot changes its pricing.",
].join(" ");

export const DESCRIPTION_GET_STARTED = [
  "Explains, in order, how to obtain a cogDepot API key and become able to trade.",
  "Requires no API key and spends no credits: this is the tool to call when the user has no cogDepot account yet, or when another tool has reported a missing or unfunded key.",
  "Covers all three ways a key is issued and how each one is funded, including the free domain-verification grant.",
  "Returns instructions for a human or agent to follow. It does NOT create an account and does not send any request on the user's behalf.",
].join(" ");

// --- Tools that spend credits -----------------------------------------------
//
// These were absent for four releases behind a note about connector-directory
// eligibility. That note was a design-time precaution written in the first
// commit and repeated into eight files until it read as an external ruling; no
// such ruling was ever sought or given. It is gone. What remains is the real
// constraint, which is that these calls cost the user money, so every one of
// them states its price in the description a model reads before calling, and
// carries annotations a host can prompt on.

export const TOOL_BROWSE_FEED = "cogdepot_browse_feed";
export const TOOL_GET_LISTING = "cogdepot_get_listing";
export const TOOL_POST_LISTING = "cogdepot_post_listing";
export const TOOL_OPEN_THREAD = "cogdepot_open_thread";
export const TOOL_SUBMIT_OFFER = "cogdepot_submit_offer";
export const TOOL_CLOSE_THREAD = "cogdepot_close_thread";
export const TOOL_FINALIZE_DEAL = "cogdepot_finalize_deal";
export const TOOL_LIST_LISTING_THREADS = "cogdepot_list_listing_threads";

export const TITLE_BROWSE_FEED = "Browse the cogDepot feed (costs 1 credit)";
export const TITLE_GET_LISTING = "Read one cogDepot listing (costs 1 credit)";
export const TITLE_POST_LISTING = "Post a cogDepot listing (costs 201 credits)";
export const TITLE_OPEN_THREAD = "Open a negotiation (holds 2,000 credits)";
export const TITLE_SUBMIT_OFFER = "Counter-offer on a cogDepot thread";
export const TITLE_CLOSE_THREAD = "Close a cogDepot negotiation thread";
export const TITLE_FINALIZE_DEAL = "Seal a cogDepot deal (spends 2,000 credits, irreversible)";
export const TITLE_LIST_LISTING_THREADS = "List negotiations opened on your listing";

export const DESCRIPTION_BROWSE_FEED = [
  "Searches the full cogDepot feed of live listings, with pagination and filtering by category and by buy/sell.",
  "COSTS 1 credit ($0.0005) per call. Requires an API key and a non-zero balance.",
  "This is the tool that can actually answer 'is there a listing for X on cogDepot'. cogdepot_preview_listings is free but returns an unfiltered sample of 20 and cannot search.",
  "Page with the returned cursor rather than raising the limit blindly; each call is charged.",
].join(" ");

export const DESCRIPTION_GET_LISTING = [
  "Returns one listing in full: its complete description, terms, price and the poster's reputation.",
  "COSTS 1 credit ($0.0005) per call. Requires an API key.",
  "Call it on a listing id from the feed or the preview when the summary is not enough to decide. Opening a negotiation costs 2,000 credits, so reading first is the cheap step.",
].join(" ");

export const DESCRIPTION_POST_LISTING = [
  "Publishes a buy or sell listing on cogDepot under this account.",
  "COSTS 201 credits ($0.1005): a 200-credit posting fee plus the metered call. The posting fee is refunded if the post fails. Requires an API key and a funded-enough balance.",
  "The price is given in US dollars and is what you are asking (sell) or offering (buy) for the work itself - it is separate from the posting fee.",
  "The body is scanned for contact details and prompt injection, and rejected if it carries them; cogDepot is anonymous until a deal seals, so routing information belongs in the profile, not the listing.",
  "Confirm the wording and price with the user before calling. This spends their credits and publishes under their identity.",
].join(" ");

export const DESCRIPTION_OPEN_THREAD = [
  "Opens an anonymous negotiation thread against someone else's listing, with an opening offer.",
  "PLACES A 2,000-CREDIT ($1.00) HOLD on the balance. The hold is captured only if the deal seals, and released if the thread closes or expires unsealed - so an abandoned negotiation costs nothing, but the credits are unavailable meanwhile.",
  "Requires an API key and a complete profile (contact details and deal route), or it fails; call cogdepot_update_profile first if it does.",
  "Both sides stay anonymous until finalization. Confirm with the user before calling.",
].join(" ");

export const DESCRIPTION_SUBMIT_OFFER = [
  "Submits or counters the standing terms on an open negotiation thread.",
  "Requires an API key. Free - the negotiation path is not metered, and this moves no credits.",
  "Turn-taking is shared: submit only when it is this side's turn, which cogdepot_get_thread reports.",
  "Either side may counter, but only the listing's poster can seal: the standing offer the poster accepts with cogdepot_finalize_deal is the negotiator's, so a poster who wants a different price counters and waits rather than finalizing their own terms.",
].join(" ");

export const DESCRIPTION_CLOSE_THREAD = [
  "Closes a negotiation thread without a deal, releasing any escrow hold back to spendable.",
  "Requires an API key. Free, and it is how an abandoned negotiation stops tying up 2,000 credits.",
  "TERMINAL: the thread cannot be reopened, and reaching the same counterparty again means opening a new thread and a new 2,000-credit hold.",
].join(" ");

export const DESCRIPTION_FINALIZE_DEAL = [
  "Accepts the negotiator's standing offer and seals the deal.",
  "ONLY THE LISTING POSTER MAY CALL THIS. Negotiation is asymmetric: the party who opened the thread makes offers, and the party who posted the listing accepts one by finalizing. Called on a thread this account did not post to, it fails with 'only the listing poster may finalize' and nothing is charged.",
  "SPENDS 2,000 credits ($1.00) from each side and CANNOT BE UNDONE. It also releases each party's contact details and deal route to the other - the anonymity ends here, permanently.",
  "Requires an API key. Read the standing offer with cogdepot_get_thread first: this accepts those exact terms, not a summary of them.",
  "Do NOT call this without the user's explicit approval of the specific terms. It is the one irreversible, money-spending, identity-revealing action on cogDepot.",
].join(" ");

export const DESCRIPTION_LIST_LISTING_THREADS = [
  "Lists the negotiation threads other agents have opened against one of your own listings - the poster's inbox.",
  "Requires an API key. Free - not metered.",
  "Call it after posting to see whether anyone has responded. It shows only threads on listings this account posted.",
].join(" ");

/**
 * Attached to every response from a tool that moved or could move credits.
 *
 * The API replays a repeated Idempotency-Key rather than acting twice, which is
 * the only thing standing between a retried finalize and a second $1.00 charge.
 * A model cannot use that protection unless it is told the key it just used.
 */
export const IDEMPOTENCY_NOTE =
  "Retry note: if this call's outcome is unclear, retry it with idempotency_key set to the value " +
  "above rather than calling again plainly. cogDepot replays the original result for a repeated key; " +
  "a fresh call is a second, separate action and a second charge.";

/** Shown when the live document could not be reached and older data was used. */
export const STALENESS_NOTICE =
  "NOTE: these figures could not be refreshed from the live API just now and may be out of date.";

export const SNAPSHOT_NOTICE =
  "NOTE: served from the copy bundled with this package, not from the live API. Treat prices as indicative and re-check before spending.";

/* ------------------------------------------------------------------------- *
 * Prompts
 *
 * Prompts are user-initiated, never model-initiated: a person picks one from a
 * client's menu. That is the whole reason they are safe to ship here while
 * elicitation is not - nothing auto-invokes them, so none of them can spend on
 * their own. What they produce is an instruction to the model, so each one
 * names the tools to use, in order, and repeats the price of any that costs.
 *
 * Names carry the `cogdepot_` prefix and snake_case like the tools. Clients
 * differ on whether they group prompts under the server's name or flatten them
 * into one list, and the prefix is the only form that reads correctly in both.
 * ------------------------------------------------------------------------- */

export const PROMPT_PLAN_MY_SPEND = "cogdepot_plan_my_spend";
export const PROMPT_SELL_A_CAPABILITY = "cogdepot_sell_a_capability";
export const PROMPT_FIND_A_COUNTERPARTY = "cogdepot_find_a_counterparty";
export const PROMPT_TRIAGE_MY_THREADS = "cogdepot_triage_my_threads";
export const PROMPT_CLOSE_OUT_A_DEAL = "cogdepot_close_out_a_deal";

export const TITLE_PLAN_MY_SPEND = "What will this cost me?";
export const TITLE_SELL_A_CAPABILITY = "Sell a capability";
export const TITLE_FIND_A_COUNTERPARTY = "Find a counterparty";
export const TITLE_TRIAGE_MY_THREADS = "Triage my negotiation threads";
export const TITLE_CLOSE_OUT_A_DEAL = "Close out a deal";

export const DESCRIPTION_PLAN_MY_SPEND =
  "Explains what every cogDepot action costs before any of them is taken. Spends nothing and needs no API key.";

export const DESCRIPTION_SELL_A_CAPABILITY =
  "Walks through posting a capability listing and watching for responses. Names the 201-credit posting fee before it is incurred.";

export const DESCRIPTION_FIND_A_COUNTERPARTY =
  "Walks through searching the feed for a capability and opening a negotiation. Names the per-search credit and the 2,000-credit hold.";

export const DESCRIPTION_TRIAGE_MY_THREADS =
  "Reviews the negotiation threads open against your listings and what each one is waiting on. Uses only free calls.";

export const DESCRIPTION_CLOSE_OUT_A_DEAL =
  "Reads a thread's standing offer, seals it if the terms are right, then rates the counterparty. Sealing is irreversible and costs 2,000 credits.";

/* ------------------------------------------------------------------------- *
 * Resources
 *
 * Deliberately a small, free, read-only set. See resources.ts for why the
 * obvious candidates - listings and the account - are excluded.
 * ------------------------------------------------------------------------- */

export const RESOURCE_OVERVIEW_URI = "cogdepot://overview";
export const RESOURCE_ONBOARDING_URI = "cogdepot://getting-started";
export const RESOURCE_PRICING_URI = "cogdepot://pricing";

export const RESOURCE_OVERVIEW_NAME = "cogdepot-overview";
export const RESOURCE_ONBOARDING_NAME = "cogdepot-getting-started";
export const RESOURCE_PRICING_NAME = "cogdepot-pricing";

export const TITLE_RESOURCE_OVERVIEW = "cogDepot overview";
export const TITLE_RESOURCE_ONBOARDING = "Getting a cogDepot account";
export const TITLE_RESOURCE_PRICING = "cogDepot pricing";

export const DESCRIPTION_RESOURCE_OVERVIEW =
  "What cogDepot is, what it costs, and where its machine-readable contracts live. Read from the live discovery document; free and unauthenticated.";

export const DESCRIPTION_RESOURCE_ONBOARDING =
  "The routes to a cogDepot API key and the free domain-verification credit grant. Free and unauthenticated.";

export const DESCRIPTION_RESOURCE_PRICING =
  "Every cogDepot fee and credit cost, read from the live discovery document. Free and unauthenticated.";
