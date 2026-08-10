import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getFacts, resetFactsCacheForTesting } from "./facts.js";
import { renderOnboarding, renderOverview } from "./core.js";
import { FACTS_TTL_MS, SNAPSHOT_NOTICE, STALENESS_NOTICE } from "./strings.js";

/** A minimal document that passes the boundary validation. */
function discoveryDocument(dealFee: string) {
  return {
    name: "cogDepot",
    tagline: "Anonymous broker for AI agents",
    apiBaseUrl: "https://api.cogdepot.com",
    credits: { dealFee, meteredCall: "1 credit per billable request" },
    registration: { method: "POST /v1/account/register", grantsCredit: false },
    anonymity: "Counterparties are anonymous until a deal finalizes.",
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  resetFactsCacheForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getFacts", () => {
  it("reports live provenance and no stale reason on a good fetch", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(discoveryDocument("2000 credits ($1.00) per side")),
    );

    const result = await getFacts();

    expect(result.provenance).toBe("live");
    expect(result.staleReason).toBeUndefined();
    expect(result.facts.credits?.["dealFee"]).toBe("2000 credits ($1.00) per side");
  });

  it("serves the cache within the TTL without refetching", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(discoveryDocument("2000 credits")));

    let clock = 1_000_000;
    const now = () => clock;

    await getFacts(now);
    clock += FACTS_TTL_MS - 1;
    const second = await getFacts(now);

    expect(second.provenance).toBe("cached");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("refetches once the TTL has elapsed, which is the freshness guarantee", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(discoveryDocument("2000 credits ($1.00) per side")))
      .mockResolvedValueOnce(jsonResponse(discoveryDocument("2500 credits ($1.25) per side")));

    let clock = 1_000_000;
    const now = () => clock;

    const before = await getFacts(now);
    clock += FACTS_TTL_MS + 1;
    const after = await getFacts(now);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(before.facts.credits?.["dealFee"]).toBe("2000 credits ($1.00) per side");
    // The property this package claims: an upstream price change reaches an
    // ALREADY-RUNNING server, with no rebuild, reinstall or republish.
    expect(after.facts.credits?.["dealFee"]).toBe("2500 credits ($1.25) per side");
  });

  it("falls back to the bundled snapshot when the network fails and nothing is cached", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));

    const result = await getFacts();

    expect(result.provenance).toBe("snapshot");
    expect(result.staleReason).toMatch(/could not be reached/);
    expect(result.facts.credits).toBeDefined();
  });

  it("prefers a stale cache over the snapshot, since it is newer", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(discoveryDocument("2000 credits")))
      .mockRejectedValue(new Error("connection reset"));

    let clock = 1_000_000;
    const now = () => clock;

    await getFacts(now);
    clock += FACTS_TTL_MS + 1;
    const result = await getFacts(now);

    expect(result.provenance).toBe("cached");
    expect(result.staleReason).toMatch(/connection reset/);
    expect(result.facts.credits?.["dealFee"]).toBe("2000 credits");
  });

  it("falls back on a non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({}, 503));

    const result = await getFacts();

    expect(result.provenance).toBe("snapshot");
    expect(result.staleReason).toMatch(/HTTP 503/);
  });

  it("falls back when a 200 carries something that is not the discovery document", async () => {
    // The realistic failure: a captive portal or misrouted CDN answering 200
    // with HTML or an unrelated payload. Accepting it would produce a facts
    // object with no prices and report it as live, which is worse than stale.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ hello: "world" }));

    const result = await getFacts();

    expect(result.provenance).toBe("snapshot");
    expect(result.staleReason).toMatch(/not the discovery document/);
  });

  it("falls back when a 200 carries a JSON array", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([1, 2, 3]));

    const result = await getFacts();

    expect(result.provenance).toBe("snapshot");
    expect(result.staleReason).toMatch(/non-object body/);
  });

  it("names a timeout as a timeout rather than a generic failure", async () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeout);

    const result = await getFacts();

    expect(result.staleReason).toMatch(/did not respond within/);
  });
});

describe("rendering", () => {
  it("includes live prices and adds no notice on the happy path", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(discoveryDocument("2000 credits ($1.00) per side")),
    );

    const text = renderOverview(await getFacts());

    expect(text).toContain("2000 credits ($1.00) per side");
    expect(text).not.toContain(STALENESS_NOTICE);
    expect(text).not.toContain(SNAPSHOT_NOTICE);
  });

  it("labels snapshot output so a stale price is never presented as current", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    const text = renderOverview(await getFacts());

    expect(text).toContain(SNAPSHOT_NOTICE);
  });

  it("drops non-string fields rather than printing [object Object]", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(discoveryDocument("2000 credits")),
    );

    const text = renderOnboarding(await getFacts());

    // registration.grantsCredit is a boolean in the real document.
    expect(text).not.toContain("grantsCredit");
    expect(text).not.toContain("[object Object]");
    expect(text).toContain("POST /v1/account/register");
  });

  it("survives a document missing every optional section", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ apiBaseUrl: "https://x" }));

    const overview = renderOverview(await getFacts());
    resetFactsCacheForTesting();
    const onboarding = renderOnboarding(await getFacts());

    expect(overview).toContain("cogDepot");
    expect(onboarding).toContain("Getting a cogDepot account");
  });
});
