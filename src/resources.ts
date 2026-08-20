/**
 * Resources: the documents, as opposed to the actions.
 *
 * A resource is context a client can attach to a conversation. That is the
 * whole difference from a tool, and it is also the hazard: **hosts fetch
 * resources on their own initiative**, to build or refresh context, without the
 * model deciding to and often without the user noticing. Anything reachable
 * here is therefore something the host may read at a time of its choosing, as
 * many times as it likes.
 *
 * So the set is deliberately small, and what is left out is the design:
 *
 * - **No listings.** `cogdepot_browse_feed` and `cogdepot_get_listing` cost a
 *   credit per call. A `cogdepot://listing/{id}` resource template would be the
 *   obvious thing to build and would hand the host a way to spend the user's
 *   money by refreshing context. The metered surface stays behind tools, where
 *   a model has to decide to call it and the price is in the description.
 *
 * - **No account.** `GET /v1/account` settles lapsed escrow holds as a side
 *   effect - it is why `cogdepot_get_account` carries `readOnlyHint: false`. A
 *   resource read is supposed to be free of consequence, and this one mutates
 *   ledger state. It stays a tool.
 *
 * What remains is the free, unauthenticated, genuinely read-only documentation:
 * what cogDepot is, what it costs, and how to get an account. All three read
 * from the same live discovery document the tools use, through the same cache,
 * so a resource and a tool cannot quote different prices.
 *
 * These are registered unconditionally, including with no credential. A user
 * deciding whether cogDepot is worth signing up for is exactly who needs them.
 */

import type { McpServer } from "@modelcontextprotocol/server";

import { renderOnboarding, renderOverview } from "./core.js";
import { getFacts, type FactsResult } from "./facts.js";
import {
  DESCRIPTION_RESOURCE_ONBOARDING,
  DESCRIPTION_RESOURCE_OVERVIEW,
  DESCRIPTION_RESOURCE_PRICING,
  RESOURCE_ONBOARDING_NAME,
  RESOURCE_ONBOARDING_URI,
  RESOURCE_OVERVIEW_NAME,
  RESOURCE_OVERVIEW_URI,
  RESOURCE_PRICING_NAME,
  RESOURCE_PRICING_URI,
  SNAPSHOT_NOTICE,
  STALENESS_NOTICE,
  TITLE_RESOURCE_ONBOARDING,
  TITLE_RESOURCE_OVERVIEW,
  TITLE_RESOURCE_PRICING,
} from "./strings.js";

/** Every resource here is markdown, and saying so lets a client render it. */
const MIME_TYPE = "text/markdown";

export function registerResources(server: McpServer): void {
  register(server, RESOURCE_OVERVIEW_NAME, RESOURCE_OVERVIEW_URI, {
    title: TITLE_RESOURCE_OVERVIEW,
    description: DESCRIPTION_RESOURCE_OVERVIEW,
    render: renderOverview,
  });

  register(server, RESOURCE_ONBOARDING_NAME, RESOURCE_ONBOARDING_URI, {
    title: TITLE_RESOURCE_ONBOARDING,
    description: DESCRIPTION_RESOURCE_ONBOARDING,
    render: renderOnboarding,
  });

  register(server, RESOURCE_PRICING_NAME, RESOURCE_PRICING_URI, {
    title: TITLE_RESOURCE_PRICING,
    description: DESCRIPTION_RESOURCE_PRICING,
    render: renderPricing,
  });
}

interface ResourceSpec {
  readonly title: string;
  readonly description: string;
  readonly render: (result: FactsResult) => string;
}

/**
 * Registers one document-backed resource.
 *
 * A failed fetch throws rather than returning prose. Tools return their errors
 * in-band because a model reads them and can correct course; a resource has no
 * such reader, and text saying "could not reach cogDepot" pinned into a
 * conversation's context would be indistinguishable from a fact about cogDepot.
 * `getFacts` already falls back to the bundled snapshot, so a throw here means
 * something genuinely unrecoverable.
 */
function register(server: McpServer, name: string, uri: string, spec: ResourceSpec): void {
  server.registerResource(
    name,
    uri,
    { title: spec.title, description: spec.description, mimeType: MIME_TYPE },
    async () => {
      const result = await getFacts();
      return {
        contents: [{ uri, mimeType: MIME_TYPE, text: spec.render(result) }],
      };
    },
  );
}

/**
 * Renders every cost cogDepot states, and nothing else.
 *
 * The overview carries prices too, but buried under what the platform is. A
 * user attaching context to ask "what will this cost" wants the fees without
 * the pitch, and a host budgeting context tokens should not have to take the
 * pitch to get them.
 *
 * Like `renderOverview`, this prints the whole `credits` block including the
 * top-up rails. That is the same deliberate call made there: describing how a
 * service can be paid is product information. It is not the operational payment
 * instruction that errors.ts strips out of a 402, where a model is mid-action.
 */
export function renderPricing(result: FactsResult): string {
  const { facts } = result;
  const lines: string[] = ["# cogDepot pricing"];

  const credits = facts.credits;
  const entries = isRecord(credits) ? Object.entries(credits) : [];
  const stated = entries.filter(([, value]) => text(value) !== undefined);

  if (stated.length === 0) {
    lines.push(
      "",
      "cogDepot's discovery document states no pricing block right now. Call cogdepot_discover for the live figures rather than assuming these are free.",
    );
  } else {
    lines.push("");
    for (const [key, value] of stated) lines.push(`- **${key}**: ${text(value)}`);
  }

  lines.push(
    "",
    "## What is free",
    "- Discovery, onboarding guidance and the anonymous listing preview: no key, no charge.",
    "- Reading your own account, listings, threads and deals: a key, but no charge.",
    "- Countering an offer and closing a thread: no charge.",
    "",
    "## What is not",
    "- Searching the feed, and reading one listing in full: metered per call.",
    "- Posting a listing: a posting fee on top of the metered call.",
    "- Opening a negotiation: a hold, released if the thread closes or expires unsealed.",
    "- Sealing a deal: charged to each side, and irreversible.",
    "",
    "The exact figures are in the block above, read live. Where this section and that block disagree, the block is right.",
  );

  if (result.provenance !== "live") {
    const notice = result.provenance === "snapshot" ? SNAPSHOT_NOTICE : STALENESS_NOTICE;
    const reason = result.staleReason ? ` (${result.staleReason})` : "";
    lines.push("", `${notice}${reason}`);
  }

  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
