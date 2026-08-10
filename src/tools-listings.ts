/**
 * Listing tools. Both free per call, and neither is affected by the pending
 * directory-eligibility question - the metered feed is still absent.
 *
 * Two tools that show listings, split by what they can see:
 *
 * - `cogdepot_preview_listings` is keyless and anonymous. It exists because the
 *   metered feed (`GET /v1/feed`) is gated, which left this server able to quote
 *   cogDepot's prices while unable to show a single thing being traded.
 * - `cogdepot_get_my_listings` is keyed, and shows only the caller's own.
 *
 * Two things make the preview unlike every other call in this package.
 *
 * It talks to the STOREFRONT, not the API. `https://cogdepot.com/api/preview` is
 * absent from `api.cogdepot.com/openapi.json`, so scripts/drift.mjs cannot reach
 * it the way it reaches every other endpoint - see the note there for what
 * guards it instead.
 *
 * It sends no API key, and must not. `CogDepotClient` is deliberately not used:
 * that class exists to attach the key and refuses to run without one. Routing
 * the preview through it would authenticate the one surface a user can look at
 * without cogDepot learning which account is looking, which is the property the
 * endpoint exists to offer.
 *
 * `GET /v1/listings/mine`, behind the keyed tool, is a real route that the
 * published OpenAPI omits - the API's route list is hand-curated and several
 * registered routes are left out on purpose. Confirmed by probe rather than
 * assumed: unauthenticated it answers 401, exactly as `/v1/account` does, where
 * a path that genuinely does not exist answers 404.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { CogDepotClient } from "./client.js";
import { isAllowedCogDepotHost } from "./config.js";
import { ApiError } from "./errors.js";
import { getFacts } from "./facts.js";
import { renderField } from "./render.js";
import { formatCredits, MICRO_USD_PER_CREDIT } from "./money.js";
import {
  DEFAULT_PREVIEW_URL,
  DESCRIPTION_GET_MY_LISTINGS,
  DESCRIPTION_PREVIEW_LISTINGS,
  PREVIEW_SCOPE_CAVEAT,
  REQUEST_TIMEOUT_MS,
  TITLE_GET_MY_LISTINGS,
  TITLE_PREVIEW_LISTINGS,
  TOOL_GET_MY_LISTINGS,
  TOOL_PREVIEW_LISTINGS,
} from "./strings.js";
import { toolError, toolText } from "./tool-result.js";

/** Fields the renderer lays out itself, in this order, before the rest. */
const HEADLINE_FIELDS = [
  "id",
  "status",
  "price_micro",
  "created_at",
  "expires_at",
  "poster_id",
] as const;

/** Free and keyless. Registered unconditionally. */
export function registerPreviewTool(server: McpServer): void {
  server.registerTool(
    TOOL_PREVIEW_LISTINGS,
    {
      title: TITLE_PREVIEW_LISTINGS,
      description: DESCRIPTION_PREVIEW_LISTINGS,
      inputSchema: z.object({}),
      annotations: {
        // Genuinely read-only, unlike cogdepot_get_account: this is an
        // unauthenticated GET against a public document and settles nothing.
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const url = await resolvePreviewUrl();
        return toolText(renderListings(await fetchPreview(url), "Live cogDepot listings (preview)"));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

/** Keyed but free. Registered only when a key is configured. */
export function registerMyListingsTool(server: McpServer, client: CogDepotClient): void {
  server.registerTool(
    TOOL_GET_MY_LISTINGS,
    {
      title: TITLE_GET_MY_LISTINGS,
      description: DESCRIPTION_GET_MY_LISTINGS,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const body = await client.request<unknown>("/v1/listings/mine");
        return toolText(renderListings(asListings(body), "This account's cogDepot listings", false));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

/**
 * The preview URL, taken from the live discovery document.
 *
 * Read live for the same reason prices are: an endpoint that moves should not
 * strand every already-installed copy. The host is then checked against the same
 * constraint `COGDEPOT_API_BASE_URL` obeys, and the two failure modes are
 * deliberately different, mirroring config.ts:
 *
 * - Field absent: fall back to the built-in URL. A document that has been
 *   reworded, or an older snapshot, is a benign absence.
 * - Field present but off-domain: refuse. That is not an omission, it is an
 *   instruction to go somewhere else, and quietly substituting the built-in URL
 *   would hide a tampered or misconfigured document rather than report it.
 *
 * No API key rides on this request, so the stakes are lower than for the API
 * base URL - but a tool that renders whatever it fetched as "cogDepot listings"
 * is still worth pinning to cogDepot.
 */
async function resolvePreviewUrl(): Promise<string> {
  const { facts } = await getFacts();
  const preview = facts["keylessPreview"];
  const stated =
    typeof preview === "object" && preview !== null
      ? (preview as Record<string, unknown>)["url"]
      : undefined;

  if (typeof stated !== "string" || stated.trim().length === 0) return DEFAULT_PREVIEW_URL;

  let parsed: URL;
  try {
    parsed = new URL(stated);
  } catch {
    throw new ApiError(
      0,
      "invalid_preview_url",
      `cogDepot's discovery document states a listing-preview URL that is not a valid URL (${stated}), so it was not called.`,
      false,
    );
  }

  if (parsed.protocol !== "https:" || !isAllowedCogDepotHost(parsed.hostname)) {
    throw new ApiError(
      0,
      "invalid_preview_url",
      `cogDepot's discovery document points the listing preview at ${parsed.origin}, which is not an https cogdepot.com host. ` +
        "Refusing to call it. Report this - the document may be misconfigured or tampered with.",
      false,
    );
  }

  return stated;
}

/** Fetches the keyless preview. No credentials are attached, by design. */
async function fetchPreview(url: string): Promise<Record<string, unknown>[]> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new ApiError(0, "network_error", `Could not reach ${url}: ${cause}`, true);
  }

  if (response.status === 429) {
    // The storefront rate limits per IP, and unlike the API it does not
    // necessarily answer with a problem document - so this is stated here
    // rather than routed through describeProblem, which would invent a reason.
    throw new ApiError(
      429,
      "rate_limited",
      "The keyless listing preview is rate limited per IP and has refused this request. Wait before retrying; an API key raises no limit here, because this endpoint takes none.",
      true,
    );
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      `http_${response.status}`,
      `The listing preview at ${url} returned HTTP ${response.status}.`,
      response.status >= 500,
    );
  }

  // Validate at the boundary. This is the storefront rather than the API, so an
  // error page is HTML and `.json()` throws - which must degrade to a stated
  // failure, not to a confident empty list that reads as "nothing is trading".
  const body: unknown = await response.json().catch(() => undefined);
  if (!isRecord(body) || !Array.isArray(body["listings"])) {
    throw new ApiError(
      0,
      "unexpected_body",
      `${url} did not return a listings array, so it is not serving the preview document.`,
      true,
    );
  }

  return (body["listings"] as unknown[]).filter(isRecord);
}

/**
 * Narrows whatever `/v1/listings/mine` returns to an array of listings.
 *
 * Tolerant of both `{listings:[...]}` and a bare array because the route is
 * absent from the published OpenAPI, so its response shape is not something this
 * package can read off a contract. An unrecognised shape yields an empty list,
 * which the renderer reports as "none" rather than as an error - the alternative
 * is failing a free, read-only call over a wrapper key.
 */
function asListings(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.filter(isRecord);
  if (isRecord(body) && Array.isArray(body["listings"])) {
    return (body["listings"] as unknown[]).filter(isRecord);
  }
  return [];
}

/**
 * Renders listings as one section each.
 *
 * Purpose-built rather than a per-listing `renderRecord` call, because a flat
 * key/value dump repeated twenty times buries the three fields that decide
 * whether a listing is worth pursuing - what it is, what it costs, whether it is
 * still live. Unrecognised fields still come through, via `renderField`, so a
 * listing growing a field does not silently lose it.
 */
export function renderListings(
  listings: readonly Record<string, unknown>[],
  heading: string,
  isPreview = true,
): string {
  const lines = [`# ${heading}`];

  if (listings.length === 0) {
    lines.push(
      "",
      isPreview
        ? "No listings are live on cogDepot right now. This is an empty market, not a failed call."
        : "This account has no listings. Posting one is not available through this server yet.",
    );
    if (isPreview) lines.push("", PREVIEW_SCOPE_CAVEAT);
    return lines.join("\n");
  }

  lines.push("", `${listings.length} listing${listings.length === 1 ? "" : "s"}.`);

  for (const listing of listings) {
    lines.push("", `## ${describeListing(listing)}`);

    for (const key of HEADLINE_FIELDS) {
      const value = listing[key];
      if (value === null || value === undefined) continue;

      if (key === "price_micro") {
        lines.push(`- **price**: ${describePrice(value, listing["price_usd"])}`);
        continue;
      }
      if (key === "poster_id") {
        lines.push(`- **poster**: ${String(value)} (opaque handle, anonymous until a deal seals)`);
        continue;
      }
      if (key === "created_at" || key === "expires_at") {
        lines.push(`- **${key === "created_at" ? "posted" : "expires"}**: ${describeTime(value)}`);
        continue;
      }
      lines.push(...renderField(key, value));
    }

    // Anything the API added that this renderer has never heard of. `price_usd`
    // is dropped rather than repeated: it is the same figure the price line
    // already states in both credits and dollars.
    for (const [key, value] of Object.entries(listing)) {
      const known: readonly string[] = HEADLINE_FIELDS;
      if (known.includes(key)) continue;
      if (key === "title" || key === "category" || key === "listing_type") continue;
      if (key === "price_usd") continue;
      lines.push(...renderField(key, value));
    }
  }

  if (isPreview) lines.push("", PREVIEW_SCOPE_CAVEAT);
  return lines.join("\n");
}

/** The heading line: what this listing is, in the words the poster used. */
function describeListing(listing: Record<string, unknown>): string {
  const title = text(listing["title"]) ?? "(untitled listing)";
  const facets = [text(listing["listing_type"]), text(listing["category"])].filter(Boolean);
  return facets.length > 0 ? `${title} (${facets.join(", ")})` : title;
}

/**
 * Prices in credits and dollars, never in µUSD.
 *
 * `price_usd` is preferred for the dollar half when the API supplies it, so the
 * figure shown is the one cogDepot itself quotes rather than one reconstructed
 * by division.
 */
function describePrice(priceMicro: unknown, priceUsd: unknown): string {
  if (typeof priceMicro !== "number" || !Number.isFinite(priceMicro)) {
    const stated = text(priceUsd);
    return stated ? `$${stated}` : String(priceMicro);
  }
  const credits = Math.floor(priceMicro / MICRO_USD_PER_CREDIT);
  const stated = text(priceUsd);
  return stated
    ? `${credits.toLocaleString("en-US")} credits ($${stated})`
    : formatCredits(credits);
}

/**
 * Renders a timestamp, whichever way the API expressed it.
 *
 * The preview mixes forms: `created_at` is ISO 8601 and `expires_at` is Unix
 * seconds. Handing a model `1786650661` is the same defect as handing it a µUSD
 * figure - a bare integer it will either ignore or misread as a duration.
 */
function describeTime(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Seconds, not milliseconds: a Unix seconds value for any plausible listing
    // is ten digits, and reading it as milliseconds would date it to 1970.
    const asDate = new Date(value * 1000);
    return Number.isNaN(asDate.getTime()) ? String(value) : asDate.toISOString();
  }
  return text(value) ?? String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
