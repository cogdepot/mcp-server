/**
 * The keyless marketplace aggregate.
 *
 * `cogdepot_get_stats` answers the one question the rest of the keyless surface
 * deliberately cannot: is anything actually happening here. `cogdepot_discover`
 * says what cogDepot is, and `cogdepot_preview_listings` shows a capped sample
 * of twenty rows whose own description bars concluding absence from it - so an
 * agent deciding whether an account is worth obtaining had no way to judge
 * volume. `GET /stats.json` on `api.cogdepot.com` is free, unmetered and
 * unauthenticated, so it appears in the published OpenAPI and scripts/drift.mjs
 * sees it like any other route.
 *
 * `CogDepotClient` is deliberately not used, on the same reasoning as the
 * preview and the reputation lookup: that class attaches the key and refuses to
 * run without one, which would both hide this tool from the audience it exists
 * for and tell cogDepot which account is asking.
 *
 * Two things this file must never do.
 *
 * It must never let a withheld figure read as a zero. cogDepot publishes the
 * sealed-deal count and the median time to seal only once enough deals exist to
 * publish them, and sends `null` until then. A quiet market and an unpublished
 * measurement are the same bytes, so rendering `null` as "0" - or omitting the
 * line - would state "no deals have sealed" as fact from data that says no such
 * thing. Absent figures are named as not stated, next to the reason.
 *
 * And it must never present a scheduled recompute as live. The payload carries
 * `generated_at`; at the time of writing the live document was two days old
 * while its cache header claimed an hour. The age is rendered next to the
 * numbers rather than in a footnote, because a model summarising this output
 * will drop a footnote and keep the figure.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { getApiBaseUrl } from "./config.js";
import { ApiError } from "./errors.js";
import {
  DESCRIPTION_GET_STATS,
  REQUEST_TIMEOUT_MS,
  TITLE_GET_STATS,
  TOOL_GET_STATS,
  USER_AGENT,
} from "./strings.js";
import { toolError, toolText } from "./tool-result.js";

/** A finite number, or undefined. `null` and absent are the same thing here. */
function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A non-empty string, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Fields rendered with a hand-written label, plus the qualifiers that describe
 * another field rather than standing alone. Anything outside this set is
 * reported generically, so a figure the API adds later still surfaces instead of
 * being silently dropped by a hardcoded list.
 */
const NAMED_FIELDS = new Set([
  "generated_at",
  "registered_agents",
  "sealed_deals",
  "sealed_deals_window_days",
  "median_seal_seconds",
  "median_seal_min_deals",
]);

/** "2 days", "3 hours", "8 minutes" - the age of a timestamp, or undefined. */
function describeAge(generatedAt: string | undefined, now: number): string | undefined {
  if (!generatedAt) return undefined;
  const at = Date.parse(generatedAt);
  if (Number.isNaN(at)) return undefined;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 90) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

/** "4 minutes 12 seconds", for the median. */
function describeDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} seconds`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  if (minutes < 60) return rest ? `${minutes} minutes ${rest} seconds` : `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hours ${minutes - hours * 60} minutes`;
}

/**
 * Renders the aggregate.
 *
 * `now` is a parameter rather than a call to `Date.now()` inside, so the age
 * line is testable without freezing the clock for the whole suite.
 */
export function renderStats(raw: Record<string, unknown>, now: number = Date.now()): string {
  const lines: string[] = ["cogDepot marketplace statistics", ""];

  const generatedAt = text(raw["generated_at"]);
  const age = describeAge(generatedAt, now);
  if (generatedAt) {
    lines.push(
      age
        ? `Generated ${generatedAt} - ${age} old. These figures are recomputed on a schedule, not live.`
        : `Generated ${generatedAt}. These figures are recomputed on a schedule, not live.`,
    );
  } else {
    // No timestamp is worse than a stale one: nothing bounds how old this is.
    lines.push(
      "cogDepot did not state when these figures were computed, so their age is unknown. They are recomputed on a schedule and are not live.",
    );
  }
  lines.push("");

  const agents = num(raw["registered_agents"]);
  lines.push(
    agents === undefined
      ? "Registered agents: not stated"
      : `Registered agents: ${agents}. This counts accounts that exist, not accounts that have traded.`,
  );

  const windowDays = num(raw["sealed_deals_window_days"]);
  const window = windowDays === undefined ? "the recent window" : `the last ${windowDays} days`;
  const sealed = num(raw["sealed_deals"]);
  lines.push(
    sealed === undefined
      ? `Deals sealed in ${window}: NOT STATED. cogDepot withholds this figure rather than publishing a small one. Not stated is not zero, and this is not evidence that no deals are happening.`
      : `Deals sealed in ${window}: ${sealed}`,
  );

  const median = num(raw["median_seal_seconds"]);
  const minDeals = num(raw["median_seal_min_deals"]);
  if (median === undefined) {
    const threshold =
      minDeals === undefined
        ? "cogDepot publishes it only once enough deals have sealed to make a median meaningful."
        : `cogDepot publishes it only once at least ${minDeals} deals have sealed.`;
    lines.push(`Median time to seal a deal: NOT STATED. ${threshold} Not stated is not zero.`);
  } else {
    lines.push(`Median time to seal a deal: ${describeDuration(median)}`);
  }

  // Anything the API has added since this file was written. Rendered without
  // interpretation - naming it is honest, guessing what it means is not.
  const extras = Object.entries(raw)
    .filter(([key, value]) => !NAMED_FIELDS.has(key) && (num(value) !== undefined || text(value)))
    .map(([key, value]) => `  ${key}: ${String(value)}`);
  if (extras.length > 0) {
    lines.push("", "Also reported by cogDepot, and not interpreted by this tool:", ...extras);
  }

  // The guidance adapts to what actually came back. Explaining what a withheld
  // figure means when nothing was withheld is noise, and noise in the part a
  // model is meant to weigh most heavily is the part it learns to skip.
  const withheld = sealed === undefined || median === undefined;
  lines.push(
    "",
    withheld
      ? "How to weigh this: registered_agents counts sign-ups rather than activity - a registered agent may have done nothing. The figures that would show real trading are the ones cogDepot suppresses while they are small, so the most decision-relevant numbers here are precisely the absent ones. Read a NOT STATED as an absent measurement, never as a zero, and do not report this marketplace as busy or as dead on the strength of it."
      : "How to weigh this: registered_agents counts sign-ups rather than activity - a registered agent may have done nothing. The sealed-deal count is the figure that shows real trading, since each one cost both sides a fee.",
  );

  if (age) {
    lines.push(
      `These numbers were computed ${age} ago. Say so if you quote them, rather than presenting them as current.`,
    );
  }

  return lines.join("\n");
}

/** Fetches the public aggregate. No credentials are attached, by design. */
async function fetchStats(userAgent: string = USER_AGENT): Promise<Record<string, unknown>> {
  const url = `${getApiBaseUrl()}/stats.json`;

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

  if (response.status === 429) {
    throw new ApiError(
      429,
      "rate_limited",
      "The marketplace statistics endpoint is rate limited per source and has refused this request. It clears on its own; wait and retry. An API key raises no limit here, because this endpoint takes none.",
      true,
    );
  }

  if (!response.ok) {
    throw new ApiError(
      response.status,
      `http_${response.status}`,
      `The marketplace statistics at ${url} returned HTTP ${response.status}.`,
      response.status >= 500,
    );
  }

  const body: unknown = await response.json().catch(() => undefined);
  // A 200 carrying HTML from a CDN error page is the realistic failure, and it
  // must not become a statistics object with no fields that reports nothing.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiError(0, "unexpected_body", `${url} did not return a statistics object.`, true);
  }
  return body as Record<string, unknown>;
}

/**
 * Registers the keyless marketplace aggregate.
 *
 * `readOnlyHint` is true and means it: an unauthenticated GET against a public
 * document that settles nothing and debits nothing, on the same footing as the
 * preview and the reputation lookup.
 */
export function registerStatsTool(server: McpServer, userAgent: string = USER_AGENT): void {
  server.registerTool(
    TOOL_GET_STATS,
    {
      title: TITLE_GET_STATS,
      description: DESCRIPTION_GET_STATS,
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
        return toolText(renderStats(await fetchStats(userAgent)));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
