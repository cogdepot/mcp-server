/**
 * Turning the API's RFC 9457 problems into something a model can act on.
 *
 * Two rules drive everything here.
 *
 * Map the REASON, never the status. The API returns 429 for two situations with
 * opposite remedies: `rate_limited` clears when the hour rolls over, and
 * `too_many_violations` is an abuse counter that backing off does NOT clear.
 * A generic "rate limited, retrying" handler makes the second case worse and
 * reads as evasion.
 *
 * Never forward the envelope. A 402 from this API carries the full x402 offer
 * array - wallet addresses, chains, token contracts, roughly 3.5KB of it. That
 * is a JSON dump in front of a language model, and worse, it is crypto payment
 * instructions, which both connector directories bar outright. The shortfall
 * numbers come out; the offers stay in.
 */

/** The subset of the problem document this package reads. */
export interface ProblemDocument {
  readonly status?: number;
  readonly title?: string;
  readonly detail?: string;
  readonly reason?: string;
  readonly creditsRemaining?: number;
  readonly creditsRequired?: number;
  readonly missing?: readonly string[];
  readonly next?: readonly { action?: string; method?: string; path?: string }[];
  readonly [key: string]: unknown;
}

/** An API failure already rendered for a model. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  readonly status: number;
  readonly reason: string;
  /** True when retrying the identical call could plausibly succeed later. */
  readonly retryable: boolean;

  constructor(status: number, reason: string, message: string, retryable: boolean) {
    super(message);
    this.status = status;
    this.reason = reason;
    this.retryable = retryable;
  }
}

/** Narrows an unknown body to a problem document without trusting its shape. */
export function asProblem(body: unknown): ProblemDocument {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  return body as ProblemDocument;
}

/**
 * Renders one problem as a short, actionable sentence.
 *
 * `topUpUrl` comes from the live facts rather than a constant, so the pointer a
 * user is given cannot drift from what the platform actually serves.
 */
export function describeProblem(
  status: number,
  problem: ProblemDocument,
  topUpUrl?: string,
): ApiError {
  const reason = typeof problem.reason === "string" ? problem.reason : `http_${status}`;

  switch (reason) {
    case "insufficient_funds_self": {
      const have = numeric(problem.creditsRemaining) ?? 0;
      const need = numeric(problem.creditsRequired) ?? 0;
      const shortfall = Math.max(0, need - have);
      // Take only the route, not the whole sentence. The live fact reads
      // "POST /dashboard/credits - Lightning or USDT/USDC on multiple chains",
      // and passing that through would hand a model the crypto payment routes
      // this mapping exists to strip from the x402 `accepts` array. Splitting
      // on the dash keeps the pointer live-sourced without the payload.
      const route = topUpUrl?.split(" - ")[0]?.trim();
      const topUp = route ? ` Top up with ${route}.` : "";
      return new ApiError(
        status,
        reason,
        `Not enough credits: this call needs ${need} and the balance is ${have}, ` +
          `so it is ${shortfall} short.${topUp} A domain you control can be verified for a free grant ` +
          `- call cogdepot_get_domain_challenge.`,
        false,
      );
    }

    case "profile_incomplete_self": {
      // The API already names the exact calls to make. Render them as steps
      // rather than as JSON, which is the difference between a model fixing
      // this by itself and a model apologising to the user.
      const steps = (problem.next ?? [])
        .map((step, index) => {
          const verb = [step.method, step.path].filter(Boolean).join(" ");
          const label = step.action ? `${step.action}: ` : "";
          return `  ${index + 1}. ${label}${verb}`;
        })
        .join("\n");
      const missing = (problem.missing ?? []).join(", ");
      return new ApiError(
        status,
        reason,
        `This account is not set up yet${missing ? ` - missing ${missing}` : ""}.` +
          (steps ? `\nComplete it with:\n${steps}` : "") +
          `\ncogdepot_update_profile does this in one call.`,
        false,
      );
    }

    case "rate_limited":
      return new ApiError(
        status,
        reason,
        "Rate limited on a free route. This is not a penalty and it clears when the hour rolls over. " +
          "Wait rather than retrying immediately.",
        true,
      );

    case "too_many_violations":
      // Deliberately NOT retryable. This is an abuse counter, and advising a
      // model to back off and retry is advising it to keep tripping it.
      return new ApiError(
        status,
        reason,
        "Blocked by an abuse counter, not a rate limit. Backing off will NOT clear this - it was " +
          "triggered by repeatedly submitting content the scrubber rejected. Stop and tell the operator; " +
          "retrying makes it worse.",
        false,
      );

    case "unauthorized":
      return new ApiError(
        status,
        reason,
        "No valid API key. Set COGDEPOT_API_KEY, or call cogdepot_get_started to learn how to obtain one.",
        false,
      );

    case "not_found": {
      const detail = text(problem.detail) ?? "the requested record does not exist";
      // Only mention the purge when the missing thing is actually a deal.
      // Attaching it to a missing thread sends a model looking for an
      // explanation that does not apply, and "it expired" is a very different
      // conclusion from "that id is wrong".
      const purgeNote = /deal/i.test(detail)
        ? " Deal records are purged 7 days after reveal, so an older deal id returns this rather than data."
        : "";
      return new ApiError(status, reason, `Not found: ${detail}.${purgeNote}`, false);
    }

    default: {
      // Unknown reason codes will happen - the API ships new ones ahead of this
      // package. Pass through the API's own prose, which is written for humans,
      // rather than inventing an interpretation.
      const detail = text(problem.detail) ?? text(problem.title) ?? `HTTP ${status}`;
      return new ApiError(status, reason, detail, status >= 500 || status === 429);
    }
  }
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
