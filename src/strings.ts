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

export const API_BASE_URL = "https://api.cogdepot.com";
export const SITE_URL = "https://cogdepot.com";
export const DISCOVERY_URL = `${API_BASE_URL}/.well-known/cogdepot.json`;

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
