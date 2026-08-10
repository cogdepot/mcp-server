/**
 * Live facts.
 *
 * The tool *structure* in this server is curated and versioned - names and
 * schemas stay stable, because an agent that learned a tool name must not find
 * it renamed by a deploy. The *facts* those tools state and return are the
 * opposite: prices, credit costs, endpoints and terms are fetched from the live
 * API at call time, so a copy installed weeks ago never quotes a stale price.
 *
 * A snapshot captured at publish time ships alongside, so an API blip degrades
 * to slightly-stale rather than broken. Every value carries its provenance, and
 * callers surface it - a number presented as current when it came from a
 * month-old snapshot is worse than one labelled as such.
 */

import snapshot from "./facts-snapshot.json" with { type: "json" };
import { DISCOVERY_URL, FACTS_TTL_MS, FACTS_FETCH_TIMEOUT_MS } from "./strings.js";

/**
 * The subset of `/.well-known/cogdepot.json` this server relies on. Deliberately
 * partial and all-optional below the top level: the document is owned by the
 * API and may grow fields this package has never heard of, which must not be a
 * parse failure. Anything absent degrades to "not stated" rather than throwing.
 */
export interface CogDepotFacts {
  readonly name?: string;
  readonly tagline?: string;
  readonly description?: string;
  readonly apiBaseUrl?: string;
  readonly agentCardUrl?: string;
  readonly openApiUrl?: string;
  // Deliberately `unknown` values, not `string`. The live document mixes types
  // inside these objects - `registration.grantsCredit` is a boolean - and
  // claiming otherwise makes the compiler agree with a fiction. Consumers go
  // through the `record()` narrowing helper, which drops non-strings.
  readonly credits?: Record<string, unknown>;
  readonly authentication?: Record<string, unknown>;
  readonly registration?: Record<string, unknown>;
  readonly domainGrant?: Record<string, unknown>;
  readonly anonymity?: string;
  readonly reputation?: Record<string, unknown> | string;
  readonly [key: string]: unknown;
}

/** Where a set of facts came from, so callers can be honest about staleness. */
export type FactsProvenance = "live" | "cached" | "snapshot";

export interface FactsResult {
  readonly facts: CogDepotFacts;
  readonly provenance: FactsProvenance;
  /** Populated only when the live fetch failed, for the tool to surface. */
  readonly staleReason?: string;
}

interface CacheEntry {
  readonly facts: CogDepotFacts;
  readonly fetchedAtMs: number;
}

let cache: CacheEntry | undefined;

/**
 * The fetch currently in flight, if any.
 *
 * Without this, a cold start where several tools resolve at once sends several
 * identical requests for the same public document. Sharing one promise makes
 * concurrent callers wait on the same round trip instead of racing to overwrite
 * the same cache entry.
 */
let inFlight: Promise<CogDepotFacts> | undefined;

/** Test seam. Resets module state so each case starts from a known point. */
export function resetFactsCacheForTesting(): void {
  cache = undefined;
  inFlight = undefined;
}

/**
 * Returns the freshest facts obtainable, in order: an unexpired cache entry, a
 * live fetch, then the bundled snapshot.
 *
 * Never throws. A discovery document that cannot be reached is a degraded
 * experience, not a failed tool call - the snapshot still answers "what is
 * cogDepot and how do I get an account", which is the whole point of the free
 * tools working with zero configuration.
 */
export async function getFacts(now: () => number = Date.now): Promise<FactsResult> {
  const cached = cache;
  if (cached && now() - cached.fetchedAtMs < FACTS_TTL_MS) {
    return { facts: cached.facts, provenance: "cached" };
  }

  try {
    // Share one round trip between concurrent callers, and clear the slot in a
    // finally so a failed fetch cannot pin every later caller to the same
    // rejection.
    inFlight ??= fetchFacts().finally(() => {
      inFlight = undefined;
    });
    const facts = await inFlight;
    cache = { facts, fetchedAtMs: now() };
    return { facts, provenance: "live" };
  } catch (error) {
    // A stale cache still beats a month-old snapshot, so prefer it even past TTL.
    if (cached) {
      return {
        facts: cached.facts,
        provenance: "cached",
        staleReason: describeFetchFailure(error),
      };
    }
    return {
      facts: snapshot as CogDepotFacts,
      provenance: "snapshot",
      staleReason: describeFetchFailure(error),
    };
  }
}

/** Fetches and validates the discovery document. Throws on any failure. */
async function fetchFacts(): Promise<CogDepotFacts> {
  const response = await fetch(DISCOVERY_URL, {
    signal: AbortSignal.timeout(FACTS_FETCH_TIMEOUT_MS),
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new FactsFetchError(`${DISCOVERY_URL} returned HTTP ${response.status}`);
  }

  const body: unknown = await response.json();

  // Validate at the boundary. A 200 carrying HTML from a captive portal or a
  // misrouted CDN is the realistic failure, and it must fall back rather than
  // become a "facts" object with no fields that silently reports no prices.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new FactsFetchError(`${DISCOVERY_URL} returned a non-object body`);
  }
  if (!("apiBaseUrl" in body) && !("credits" in body)) {
    throw new FactsFetchError(
      `${DISCOVERY_URL} returned JSON without apiBaseUrl or credits, so it is not the discovery document`,
    );
  }

  return body as CogDepotFacts;
}

/** Marker for failures originating in this module rather than in the caller. */
export class FactsFetchError extends Error {
  override readonly name = "FactsFetchError";
}

/**
 * Renders a fetch failure as one short clause suitable for appending to a tool
 * response. Deliberately not a stack trace: the reader is a language model
 * deciding what to tell a user, and a stack teaches it nothing actionable.
 */
function describeFetchFailure(error: unknown): string {
  if (error instanceof FactsFetchError) return error.message;
  if (error instanceof Error) {
    if (error.name === "TimeoutError") {
      return `${DISCOVERY_URL} did not respond within ${FACTS_FETCH_TIMEOUT_MS}ms`;
    }
    return `${DISCOVERY_URL} could not be reached: ${error.message}`;
  }
  return `${DISCOVERY_URL} could not be reached`;
}
