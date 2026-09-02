/**
 * The keyless reputation lookup.
 *
 * `cogdepot_get_reputation` is the fourth tool in this package that needs no API
 * key, and it is the only one that answers a question about somebody else. That
 * is the point: the party who most needs a trust signal is the one deciding
 * whether to deal at all, and that party does not have an account yet. A key
 * gate here would publish the record only to people who had already decided.
 *
 * It calls the API rather than the storefront, unlike the listing preview. The
 * endpoint is `GET /v1/reputation/{handle}` on `api.cogdepot.com`, free,
 * unmetered and unauthenticated, so it appears in the published OpenAPI and
 * scripts/drift.mjs can see it the way it sees every other route.
 *
 * `CogDepotClient` is deliberately not used, for the same reason the preview
 * avoids it: that class exists to attach the key and refuses to run without one.
 * Routing this through it would both make the tool unavailable to the audience
 * it exists for and tell cogDepot which account is asking about whom - a
 * disclosure the endpoint is specifically designed not to require.
 *
 * The one thing this file must never do is present a warm start as a record.
 * Every cogDepot account is seeded with one synthetic 5-star rating per role, so
 * an agent that has never traded renders as a flawless 5.0. The API computes
 * `warm_start` server-side and sends it with the numbers; this renders the
 * caveat next to the stars rather than in a footnote, because a model
 * summarising the output will drop a footnote and keep the 5.0.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { getApiBaseUrl } from "./config.js";
import { ApiError } from "./errors.js";
import {
  DESCRIPTION_GET_REPUTATION,
  REQUEST_TIMEOUT_MS,
  TITLE_GET_REPUTATION,
  TOOL_GET_REPUTATION,
  USER_AGENT,
} from "./strings.js";
import { toolError, toolText } from "./tool-result.js";

/** A handle is exactly 12 lowercase hex characters. */
const HANDLE_PATTERN = /^[0-9a-f]{12}$/;

/** One role's facet, after narrowing. */
type Facet = {
  ratingSum: number;
  ratingCount: number;
  finalizedCount: number;
  nonDeliveryCount: number;
  warmStart: boolean;
};

/** Narrows an unknown facet payload without trusting its shape. */
function toFacet(raw: unknown): Facet {
  const f = (raw ?? {}) as Record<string, unknown>;
  return {
    ratingSum: Number(f["rating_sum"] ?? 0),
    ratingCount: Number(f["rating_count"] ?? 0),
    finalizedCount: Number(f["finalized_count"] ?? 0),
    nonDeliveryCount: Number(f["non_delivery_count"] ?? 0),
    // Defaults TRUE when the field is missing. An absent flag must never read as
    // "this record is earned": the honest failure here is to over-caveat, and a
    // server that stopped sending the field would otherwise silently upgrade
    // every warm start into a track record.
    warmStart: f["warm_start"] !== false,
  };
}

/**
 * Renders one role's facet.
 *
 * The mean is computed here rather than requested, because the API deliberately
 * returns sums and counts and never a float - it stores no floats anywhere. The
 * count travels beside the mean for the same reason the API sends it: 5.0 from
 * one rating and 5.0 from four hundred are the same number and not remotely the
 * same claim.
 */
function renderFacet(role: string, facet: Facet): string[] {
  const mean =
    facet.ratingCount > 0 ? (facet.ratingSum / facet.ratingCount).toFixed(1) : "no ratings";
  const lines = [
    `As a ${role}:`,
    `  rating: ${mean} over ${facet.ratingCount} rating${facet.ratingCount === 1 ? "" : "s"}`,
    `  completed deals: ${facet.finalizedCount}`,
    `  non-delivery reports: ${facet.nonDeliveryCount}`,
  ];
  if (facet.warmStart) {
    lines.push(
      "  WARM START - this is the seeded starting rating and no deal has ever sealed in this role. It was not earned. Do not report it as a track record.",
    );
  }
  return lines;
}

/** Renders the whole record for a model to read. */
function renderReputation(handle: string, body: Record<string, unknown>): string {
  const seller = toFacet(body["seller"]);
  const buyer = toFacet(body["buyer"]);
  const funded = body["funded"] === true;
  const domainVerified = body["domain_verified"] === true;

  const lines = [
    `cogDepot reputation for agent ${handle}`,
    "",
    ...renderFacet("seller", seller),
    "",
    ...renderFacet("buyer", buyer),
    "",
    `Funded with real money: ${funded ? "yes" : "no"}`,
    `Domain verified: ${domainVerified ? "yes" : "no"}`,
  ];

  if (typeof body["as_of"] === "string" && body["as_of"].length > 0) {
    lines.push(`Read at: ${body["as_of"]}`);
  }

  lines.push(
    "",
    "How to weigh this: finalized_count is the unfakeable figure - it is never seeded and each one cost both sides a real fee. " +
      "cogDepot attests only to deals it settled, and a rating moves only when at least one side was funded with real money, " +
      "so a pair of unfunded accounts trading with each other move no counters at all.",
  );

  if (!funded && seller.warmStart && buyer.warmStart) {
    lines.push(
      "",
      "This agent has no record of any kind: never funded, and a warm start on both sides. That is not a bad record, it is an absent one. Treat it as an unknown counterparty.",
    );
  }

  return lines.join("\n");
}

/** Fetches the public record. No credentials are attached, by design. */
async function fetchReputation(
  handle: string,
  userAgent: string = USER_AGENT,
): Promise<Record<string, unknown>> {
  const url = `${getApiBaseUrl()}/v1/reputation/${encodeURIComponent(handle)}`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": userAgent },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    throw new ApiError(0, "network_error", `Could not reach ${url}: ${cause}`, true);
  }

  if (response.status === 404) {
    // Stated rather than routed through describeProblem, because the honest
    // answer names both causes: the API deliberately does not distinguish an
    // unknown handle from a malformed one, so neither may this.
    throw new ApiError(
      404,
      "not_found",
      `No cogDepot account holds the handle ${handle}. Either no such agent exists, or the handle was mistyped - cogDepot answers both cases identically and this tool cannot tell them apart. Handles are exactly 12 hex characters and appear as poster_id on listings.`,
      false,
    );
  }

  if (response.status === 429) {
    throw new ApiError(
      429,
      "rate_limited",
      "The reputation lookup is rate limited per source and has refused this request. It clears on its own; wait and retry. An API key raises no limit here, because this endpoint takes none.",
      true,
    );
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      `http_${response.status}`,
      `The reputation lookup at ${url} returned HTTP ${response.status}.`,
      response.status >= 500,
    );
  }

  const body: unknown = await response.json().catch(() => undefined);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(
      0,
      "unexpected_body",
      `${url} did not return a reputation object.`,
      true,
    );
  }
  return body as Record<string, unknown>;
}

/**
 * Registers the keyless reputation lookup.
 *
 * `readOnlyHint` is true and means it: this is an unauthenticated GET against a
 * public document that settles nothing and debits nothing. That is unlike
 * `cogdepot_get_account`, which cannot claim it because reading an account
 * settles lapsed escrow holds, and unlike the metered reads, which debit a
 * credit. The hints drive host auto-permissions, so the distinction is load
 * bearing rather than decorative.
 */
export function registerReputationTool(server: McpServer, userAgent: string = USER_AGENT): void {
  server.registerTool(
    TOOL_GET_REPUTATION,
    {
      title: TITLE_GET_REPUTATION,
      description: DESCRIPTION_GET_REPUTATION,
      inputSchema: z.object({
        handle: z
          .string()
          .describe(
            "The agent's 12-character hex handle, as shown in a listing's poster_id (for example a3f19c02b7e4).",
          ),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ handle }: { handle: string }) => {
      try {
        const normalised = handle.trim().toLowerCase();
        // Validated here rather than left to the API. The shape is knowable
        // locally, and refusing a malformed handle without a round trip means a
        // model that hallucinated an account id gets told what a handle is
        // instead of a 404 it will read as "this agent does not exist".
        if (!HANDLE_PATTERN.test(normalised)) {
          throw new ApiError(
            0,
            "invalid_handle",
            `"${handle}" is not a cogDepot handle. A handle is exactly 12 hexadecimal characters (0-9, a-f) and appears as poster_id on a listing. This is not a listing id, a deal id or an account id.`,
            false,
          );
        }
        return toolText(renderReputation(normalised, await fetchReputation(normalised, userAgent)));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
