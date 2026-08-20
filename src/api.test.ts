import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, asProblem, describeProblem } from "./errors.js";
import { CogDepotClient, MissingApiKeyError } from "./client.js";
import { creditRateLooksCurrent, describeBalance, formatCredits } from "./money.js";
import { renderAccount } from "./tools-account.js";
import { toolError, toolText } from "./tool-result.js";
import { resetFactsCacheForTesting } from "./facts.js";

beforeEach(() => {
  resetFactsCacheForTesting();
  // The client reads live facts for the top-up pointer when mapping an error.
  // Without this stub that reaches the real API, which makes the suite slow and
  // dependent on the network being up - a test that can fail for reasons
  // unrelated to the code is worse than no test.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(JSON.stringify({ apiBaseUrl: "https://api.cogdepot.com", credits: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("describeProblem", () => {
  it("turns a 402 into a shortfall sentence and drops the x402 offers entirely", () => {
    // The real 402 body is ~3.5KB of wallet addresses, chains and token
    // contracts. Forwarding it would be a JSON dump AND crypto payment
    // instructions in front of a model, which both directories bar.
    const problem = asProblem({
      reason: "insufficient_funds_self",
      creditsRemaining: 3,
      creditsRequired: 200,
      accepts: [{ payTo: "0xdeadbeef", asset: "0xUSDC", network: "base" }],
      detail: "Insufficient credits. Pay one of the offers below to continue.",
    });

    const error = describeProblem(402, problem, "POST /dashboard/credits");

    expect(error.message).toContain("needs 200");
    expect(error.message).toContain("balance is 3");
    expect(error.message).toContain("197 short");
    expect(error.message).toContain("POST /dashboard/credits");
    expect(error.message).not.toContain("0xdeadbeef");
    expect(error.message).not.toMatch(/base|USDC|payTo/);
    expect(error.retryable).toBe(false);
  });

  it("strips the crypto rails out of the live top-up pointer", () => {
    // The live fact is "POST /dashboard/credits - Lightning or USDT/USDC on
    // multiple chains." Passing it through whole would hand a model the crypto
    // payment routes this mapping exists to strip from the x402 offer array,
    // which is also the category both connector directories bar.
    const error = describeProblem(
      402,
      asProblem({ reason: "insufficient_funds_self", creditsRemaining: 0, creditsRequired: 200 }),
      "POST /dashboard/credits - Lightning or USDT/USDC on multiple chains.",
    );

    expect(error.message).toContain("POST /dashboard/credits");
    expect(error.message).not.toMatch(/Lightning|USDT|USDC|chains/);
  });

  it("renders 428 next steps as numbered instructions rather than JSON", () => {
    const error = describeProblem(
      428,
      asProblem({
        reason: "profile_incomplete_self",
        missing: ["contact_name", "deal_route"],
        next: [
          { action: "set_contact", method: "PUT", path: "/v1/account/contact" },
          { action: "set_route", method: "PUT", path: "/v1/account/route" },
        ],
      }),
    );

    expect(error.message).toContain("1. set_contact: PUT /v1/account/contact");
    expect(error.message).toContain("2. set_route: PUT /v1/account/route");
    expect(error.message).not.toContain("{");
  });

  it("keeps the API's own reassurance on a 428, verbatim", () => {
    // Captured from staging on 2026-08-10. "No fee was taken" is the sentence a
    // model needs most after a failed fee-bearing action, and a message rebuilt
    // from `missing` and `next` alone cannot know it.
    const error = describeProblem(
      428,
      asProblem({
        reason: "profile_incomplete_self",
        detail:
          "Your account cannot enter a deal until its contact details and deal route are set. No fee was taken.",
        missing: ["contact_name", "contact_email", "deal_route"],
        next: [
          { action: "set_contact", method: "PUT", path: "/v1/account/contact" },
          { action: "set_route", method: "PUT", path: "/v1/account/route" },
        ],
      }),
    );

    expect(error.message).toContain("No fee was taken");
    expect(error.message).toContain("Missing: contact_name, contact_email, deal_route");
    expect(error.message).toContain("1. set_contact: PUT /v1/account/contact");
  });

  it("quotes the exact retry delay the API gives, rather than guessing", () => {
    // Also captured from staging. The API states 3600; reconstructing "wait for
    // the hour to roll over" throws away a number it handed us.
    const error = describeProblem(
      429,
      asProblem({
        reason: "rate_limited",
        detail: "Too many registrations from this source. This is not a penalty and clears on its own.",
        retryAfterSeconds: 3600,
      }),
    );

    expect(error.message).toContain("3600 seconds");
    expect(error.message).toContain("60 minutes");
    expect(error.message).toContain("not a penalty");
    expect(error.retryable).toBe(true);
  });

  it("still explains rate_limited when no delay is given", () => {
    const error = describeProblem(429, asProblem({ reason: "rate_limited" }));
    expect(error.message).toContain("clears when the hour rolls over");
    expect(error.retryable).toBe(true);
  });

  it("treats rate_limited as retryable", () => {
    const error = describeProblem(429, asProblem({ reason: "rate_limited" }));
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/not a penalty/i);
  });

  it("treats too_many_violations as NOT retryable, since backing off never clears it", () => {
    // Same status as rate_limited, opposite remedy. Advising a model to back
    // off and retry here tells it to keep tripping the counter.
    const error = describeProblem(429, asProblem({ reason: "too_many_violations" }));
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/will NOT clear/);
    expect(error.message).toMatch(/tell the operator/i);
  });

  it("explains that a missing deal may simply have been purged", () => {
    const error = describeProblem(404, asProblem({ reason: "not_found", detail: "deal not found" }));
    expect(error.message).toMatch(/purged 7 days/);
  });

  it("does not blame the purge window for a missing thread", () => {
    // "It expired" and "that id is wrong" lead a model somewhere very
    // different, and threads are not subject to the deal purge at all.
    const error = describeProblem(
      404,
      asProblem({ reason: "not_found", detail: "thread not found" }),
    );
    expect(error.message).toContain("thread not found");
    expect(error.message).not.toMatch(/purged/);
  });

  it("passes through the API's own prose for reason codes it has never seen", () => {
    // The API ships new reason codes ahead of this package; inventing an
    // interpretation would be worse than quoting it.
    const error = describeProblem(409, asProblem({ reason: "brand_new_code", detail: "Nope." }));
    expect(error.reason).toBe("brand_new_code");
    expect(error.message).toBe("Nope.");
  });

  it("marks 5xx retryable and 4xx not", () => {
    expect(describeProblem(503, asProblem({})).retryable).toBe(true);
    expect(describeProblem(400, asProblem({})).retryable).toBe(false);
  });

  it("renders 428 even when the API names neither the missing fields nor the steps", () => {
    // Degraded responses are the realistic case during an incident, and a
    // handler that only works on the happy shape is a handler that fails when
    // it matters.
    const error = describeProblem(428, asProblem({ reason: "profile_incomplete_self" }));
    expect(error.message).toMatch(/not set up yet/);
    expect(error.message).toMatch(/cogdepot_update_profile/);
  });

  it("renders 402 with no figures and no top-up pointer", () => {
    const error = describeProblem(402, asProblem({ reason: "insufficient_funds_self" }));
    expect(error.message).toContain("needs 0");
    expect(error.message).not.toContain("Top up at");
  });

  it("falls back to the title when a problem carries no detail", () => {
    const error = describeProblem(418, asProblem({ title: "I am a teapot" }));
    expect(error.message).toBe("I am a teapot");
  });

  it("names a not_found with no detail", () => {
    const error = describeProblem(404, asProblem({ reason: "not_found" }));
    expect(error.message).toMatch(/does not exist/);
  });

  it("tolerates a body that is not a problem document at all", () => {
    expect(asProblem("<html>")).toEqual({});
    expect(asProblem(null)).toEqual({});
    expect(asProblem([1])).toEqual({});
    expect(describeProblem(500, asProblem("<html>")).message).toBe("HTTP 500");
  });
});

describe("money", () => {
  // Anchored on facts cogDepot publishes, NOT on this package's constant. The
  // welcome credit is documented as 20,000 credits for $10.00, and the x402
  // manifest sells 10,000 credits for $5.00. Both give 500 uUSD per credit.
  // Asserting against the constant would just restate whatever it happens to
  // say, which is exactly how the 0.1.2 tests passed with a 10x error in them.
  const WELCOME_CREDIT_MICRO = 10_000_000; // $10.00
  const WELCOME_CREDIT_CREDITS = 20_000;

  it("reports the documented welcome credit as its documented credit count", () => {
    const balance = describeBalance(WELCOME_CREDIT_MICRO, 0);
    expect(balance.credits).toBe(WELCOME_CREDIT_CREDITS);
    expect(balance.usd).toBe("$10.00");
  });

  it("agrees with the x402 manifest's credit pack", () => {
    // 10,000 credits for $5.00.
    const balance = describeBalance(5_000_000, 0);
    expect(balance.credits).toBe(10_000);
    expect(balance.usd).toBe("$5.00");
  });

  it("prices a deal fee at the documented 2000 credits for $1.00", () => {
    expect(formatCredits(2_000)).toBe("2,000 credits ($1.00)");
  });

  it("converts uUSD to credits and dollars", () => {
    const balance = describeBalance(20_000_000, 100_000);
    expect(balance.credits).toBe(40_000);
    expect(balance.usd).toBe("$20.00");
    expect(balance.heldCredits).toBe(200);
    expect(balance.heldUsd).toBe("$0.10");
  });

  it("treats a missing or non-numeric balance as zero rather than NaN", () => {
    const balance = describeBalance(undefined, "nonsense");
    expect(balance.credits).toBe(0);
    expect(balance.usd).toBe("$0.00");
  });

  it("formats the listing fee, 200 credits, at its documented $0.10", () => {
    expect(formatCredits(200)).toBe("200 credits ($0.10)");
  });

  it("flags a repriced credit rather than converting at a stale rate", () => {
    expect(creditRateLooksCurrent("1 credit ($0.0005) per billable request")).toBe(true);
    expect(creditRateLooksCurrent("1 credit ($0.001) per billable request")).toBe(false);
    // Absent or rephrased text is not treated as a mismatch.
    expect(creditRateLooksCurrent(undefined)).toBe(true);
  });
});

describe("renderAccount", () => {
  const account = {
    balance_micro: 0,
    held_micro: 0,
    status: "active",
    reputation: {
      buyer: { rating_sum: 5, rating_count: 1, finalized_count: 0 },
      seller: { rating_sum: 25, rating_count: 5, finalized_count: 4 },
      funded: false,
    },
  };

  it("never exposes a raw uUSD field to the model", () => {
    const text = renderAccount(account, "1 credit ($0.0005)");
    expect(text).not.toMatch(/_micro/);
    expect(text).toContain("0 credits ($0.00)");
  });

  it("discounts the synthetic rating when reporting real counterparty count", () => {
    const text = renderAccount(account, "1 credit ($0.0005)");
    expect(text).toContain("5.0 over 1 rating(s) - 0 from real counterparties");
    expect(text).toContain("5.0 over 5 rating(s) - 4 from real counterparties");
    expect(text).toMatch(/synthetic/);
  });

  it("warns when the credit rate no longer matches, rather than quoting bad dollars", () => {
    const text = renderAccount(account, "1 credit ($0.002)");
    expect(text).toMatch(/outdated rate/);
  });

  it("handles an empty account record", () => {
    expect(renderAccount(undefined, undefined)).toMatch(/empty account record/);
  });

  it("shows n/a rather than NaN when a facet carries no ratings", () => {
    const text = renderAccount(
      {
        balance_micro: 0,
        held_micro: 0,
        reputation: { buyer: { rating_sum: 0, rating_count: 0, finalized_count: 0 } },
      },
      "1 credit = $0.0005 USD",
    );
    expect(text).toContain("n/a");
    expect(text).not.toContain("NaN");
  });

  it("renders a reputation value that is not an object", () => {
    const text = renderAccount(
      { balance_micro: 0, held_micro: 0, reputation: { domain_verified: false } },
      "1 credit = $0.0005 USD",
    );
    expect(text).toContain("domain_verified: false");
  });
});

describe("CogDepotClient", () => {
  function response(body: unknown, status = 200): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  it("refuses to call without a key, and says how to get one", async () => {
    const client = new CogDepotClient(undefined);
    expect(client.hasKey).toBe(false);
    await expect(client.request("/v1/account")).rejects.toBeInstanceOf(MissingApiKeyError);
  });

  it("sends the key as x-api-key", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ ok: true }));
    const client = new CogDepotClient("secret", "https://api.example.com", fetchImpl as never);

    await client.request("/v1/account");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example.com/v1/account");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("secret");
  });

  it("sends a bearer credential as Authorization: Bearer, not x-api-key", async () => {
    // The relay path: a verified Cognito access token is presented to cogDepot as
    // a Bearer, which its scope middleware re-verifies. The API key header must be
    // absent so the two credentials are never sent at once.
    const fetchImpl = vi.fn().mockResolvedValue(response({ ok: true }));
    const client = new CogDepotClient(
      { kind: "bearer", value: "access-token-xyz" },
      "https://api.example.com",
      fetchImpl as never,
    );

    await client.request("/v1/account");

    const headers = (fetchImpl.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer access-token-xyz");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("sends an explicit api-key credential as x-api-key, like the bare-string form", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ ok: true }));
    const client = new CogDepotClient(
      { kind: "api-key", value: "secret" },
      "https://api.example.com",
      fetchImpl as never,
    );

    await client.request("/v1/account");

    const headers = (fetchImpl.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("secret");
    expect(headers["authorization"]).toBeUndefined();
  });

  it("treats a blank bearer value as no credential, not an empty header", async () => {
    const client = new CogDepotClient({ kind: "bearer", value: "   " });
    expect(client.hasKey).toBe(false);
    await expect(client.request("/v1/account")).rejects.toBeInstanceOf(MissingApiKeyError);
  });

  it("returns undefined for 204 instead of failing to parse an empty body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(null, 204));
    const client = new CogDepotClient("k", "https://api.example.com", fetchImpl as never);

    await expect(client.request("/v1/account/contact", { method: "PUT", body: {} })).resolves.toBeUndefined();
  });

  it("maps a non-2xx through the problem renderer", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(response({ reason: "unauthorized", detail: "nope" }, 401));
    const client = new CogDepotClient("k", "https://api.example.com", fetchImpl as never);

    await expect(client.request("/v1/account")).rejects.toMatchObject({
      name: "ApiError",
      reason: "unauthorized",
    });
  });

  it("reports a transport failure as a transport failure, not a fake status", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new CogDepotClient("k", "https://api.example.com", fetchImpl as never);

    const error = await client.request("/v1/account").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(0);
    expect((error as ApiError).reason).toBe("network_error");
    expect((error as ApiError).retryable).toBe(true);
  });

  it("strips a trailing slash from the base url so paths do not double up", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({}));
    const client = new CogDepotClient("k", "https://api.example.com/", fetchImpl as never);

    await client.request("/v1/account");

    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe("https://api.example.com/v1/account");
  });
});

describe("tool results", () => {
  it("marks API failures as tool errors so the model can self-correct", () => {
    const result = toolError(new ApiError(402, "insufficient_funds_self", "short by 5", false));
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Do not retry");
  });

  it("omits the do-not-retry line when retrying could work", () => {
    const result = toolError(new ApiError(503, "x", "upstream hiccup", true));
    expect(result.content[0]?.text).not.toContain("Do not retry");
  });

  it("never leaks a stack trace", () => {
    const result = toolError(new Error("boom"));
    expect(result.content[0]?.text).toBe("Unexpected failure: boom");
  });

  it("renders a non-Error throw", () => {
    expect(toolError("bare string").content[0]?.text).toContain("bare string");
  });

  it("shapes success without an error flag", () => {
    expect(toolText("hello")).toEqual({ content: [{ type: "text", text: "hello" }] });
  });

  it("tells a keyless caller how to get a key instead of reporting a bare failure", () => {
    const result = toolError(new MissingApiKeyError());
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/COGDEPOT_API_KEY/);
    expect(result.content[0]?.text).toMatch(/cogdepot_get_started/);
  });
});
