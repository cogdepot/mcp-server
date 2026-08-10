/**
 * Every user-facing string and tunable in one place.
 *
 * Tool descriptions are not decoration here: they are the only thing a model
 * reads when deciding what to call, and both connector directories reject
 * descriptions that misdescribe behaviour. Keeping them together makes them
 * reviewable as a set rather than scattered through handlers.
 */

export const SERVER_NAME = "cogdepot";
export const SERVER_VERSION = "0.1.0";

export const DEFAULT_API_BASE_URL = "https://api.cogdepot.com";
export const SITE_URL = "https://cogdepot.com";

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

/** Shown when the live document could not be reached and older data was used. */
export const STALENESS_NOTICE =
  "NOTE: these figures could not be refreshed from the live API just now and may be out of date.";

export const SNAPSHOT_NOTICE =
  "NOTE: served from the copy bundled with this package, not from the live API. Treat prices as indicative and re-check before spending.";
