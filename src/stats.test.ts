import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { buildServer } from "./core.js";
import { renderStats } from "./tools-stats.js";
import { resetFactsCacheForTesting } from "./facts.js";
import { TOOL_GET_STATS } from "./strings.js";

/**
 * The keyless marketplace aggregate.
 *
 * Most of what is asserted here is honesty rather than plumbing, on the same
 * reasoning as the reputation tool. cogDepot sends `null` for the sealed-deal
 * count and the median until enough deals exist to publish them, so a quiet
 * market and an unpublished measurement are the same bytes on the wire. A
 * renderer that printed `null` as 0 - or dropped the line - would let a model
 * report "no deals have sealed on cogDepot" as fact from a payload that says no
 * such thing. That is the defect these tests exist to prevent.
 *
 * The second one is staleness. The figures are recomputed on a schedule; the
 * live document was two days old while its own cache header claimed an hour.
 */

/** The live payload, verbatim, on 2026-09-03. Both interesting figures null. */
const LIVE_PAYLOAD = {
  generated_at: "2026-09-01T22:56:40Z",
  median_seal_min_deals: 10,
  median_seal_seconds: null,
  registered_agents: 24,
  sealed_deals: null,
  sealed_deals_window_days: 30,
};

/** 2026-09-03T22:56:40Z - two days after the fixture was generated. */
const NOW = Date.parse("2026-09-03T22:56:40Z");

function routeFetch(routes: Record<string, unknown>) {
  const calls: { url: string; userAgent: string | undefined }[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    calls.push({ url, userAgent: headers.get("user-agent") ?? undefined });
    const match = Object.keys(routes).find((path) => url.includes(path));
    const route = match ? (routes[match] as { status?: number; body?: unknown; raw?: string }) : undefined;
    if (!route) return new Response("{}", { status: 404 });
    return new Response(route.raw ?? JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { "content-type": route.raw ? "text/html" : "application/json" },
    });
  });
  return { impl, calls };
}

async function callStats() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([buildServer().connect(serverTransport), client.connect(clientTransport)]);
  const result = await client.callTool({ name: TOOL_GET_STATS, arguments: {} });
  const text = (result.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");
  await client.close();
  return { text, isError: Boolean(result.isError) };
}

beforeEach(() => {
  resetFactsCacheForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a withheld figure is never rendered as zero", () => {
  it("names the missing sealed-deal count as not stated, and says so is not zero", () => {
    const rendered = renderStats(LIVE_PAYLOAD, NOW);

    expect(rendered).toContain("NOT STATED");
    expect(rendered).toMatch(/Deals sealed in the last 30 days: NOT STATED/);
    expect(rendered).toContain("Not stated is not zero");
  });

  it("never prints a zero anywhere for a payload whose figures are all null", () => {
    // The blunt version of the assertion above, and the one that would catch a
    // renderer that started coercing null through Number() somewhere.
    const rendered = renderStats(
      { ...LIVE_PAYLOAD, registered_agents: null },
      NOW,
    );

    expect(rendered).not.toMatch(/: 0\b/);
    expect(rendered).not.toContain("null");
  });

  it("explains the threshold that withholds the median, using the API's own number", () => {
    const rendered = renderStats(LIVE_PAYLOAD, NOW);

    expect(rendered).toMatch(/Median time to seal a deal: NOT STATED/);
    expect(rendered).toContain("at least 10 deals have sealed");
  });

  it("falls back to a generic reason when the threshold itself is absent", () => {
    const { median_seal_min_deals: _omitted, ...withoutThreshold } = LIVE_PAYLOAD;
    const rendered = renderStats(withoutThreshold, NOW);

    expect(rendered).toContain("enough deals have sealed to make a median meaningful");
    expect(rendered).not.toContain("at least undefined");
  });

  it("renders real figures plainly when cogDepot does publish them", () => {
    const rendered = renderStats(
      { ...LIVE_PAYLOAD, sealed_deals: 42, median_seal_seconds: 930 },
      NOW,
    );

    expect(rendered).toContain("Deals sealed in the last 30 days: 42");
    expect(rendered).toContain("Median time to seal a deal: 15 minutes 30 seconds");
    expect(rendered).not.toContain("NOT STATED");
  });
});

describe("a scheduled recompute is never presented as live", () => {
  it("states the age next to the numbers, not in a footnote", () => {
    const rendered = renderStats(LIVE_PAYLOAD, NOW);

    expect(rendered).toContain("2 days old");
    expect(rendered).toContain("recomputed on a schedule, not live");
    expect(rendered).toContain("Say so if you quote them");
  });

  it("says the age is unknown when cogDepot states no timestamp", () => {
    const { generated_at: _omitted, ...withoutTimestamp } = LIVE_PAYLOAD;
    const rendered = renderStats(withoutTimestamp, NOW);

    expect(rendered).toContain("did not state when these figures were computed");
    expect(rendered).not.toContain("NaN");
  });

  it("does not claim an age it cannot compute from an unparseable timestamp", () => {
    const rendered = renderStats({ ...LIVE_PAYLOAD, generated_at: "not a date" }, NOW);

    expect(rendered).toContain("Generated not a date.");
    expect(rendered).not.toContain("NaN");
  });
});

describe("the units it reports figures in", () => {
  it.each([
    [45, "45 seconds"],
    [930, "15 minutes 30 seconds"],
    [900, "15 minutes"],
    [7500, "2 hours 5 minutes"],
  ])("renders a %ds median as %s", (seconds, expected) => {
    const rendered = renderStats({ ...LIVE_PAYLOAD, median_seal_seconds: seconds }, NOW);

    expect(rendered).toContain(`Median time to seal a deal: ${expected}`);
  });

  it.each([
    ["2026-09-03T22:56:10Z", "30 seconds"],
    ["2026-09-03T22:16:40Z", "40 minutes"],
    ["2026-09-03T10:56:40Z", "12 hours"],
    ["2026-09-01T22:56:40Z", "2 days"],
  ])("describes a document generated at %s as %s old", (generatedAt, expected) => {
    // The age is the line that stops a scheduled figure being quoted as live,
    // so each unit boundary is pinned rather than assumed.
    const rendered = renderStats({ ...LIVE_PAYLOAD, generated_at: generatedAt }, NOW);

    expect(rendered).toContain(`${expected} old`);
  });

  it("does not report a negative age for a clock that is behind", () => {
    // A timestamp from the future is a clock-skew artefact, not a fact about
    // the data. Clamped rather than rendered as "-3 hours old".
    const rendered = renderStats({ ...LIVE_PAYLOAD, generated_at: "2026-09-04T22:56:40Z" }, NOW);

    expect(rendered).not.toMatch(/-\d+ (seconds|minutes|hours|days) old/);
    expect(rendered).toContain("0 seconds old");
  });
});

describe("the aggregate does not overstate what it measures", () => {
  it("says the agent count is sign-ups rather than activity", () => {
    const rendered = renderStats(LIVE_PAYLOAD, NOW);

    expect(rendered).toContain("Registered agents: 24");
    expect(rendered).toContain("not accounts that have traded");
  });

  it("surfaces a field the API adds later without inventing a meaning for it", () => {
    // The payload is owned by the API and may grow. A hardcoded field list would
    // silently drop a new figure - including the live listing count this
    // endpoint's OpenAPI summary claims and does not currently send.
    const rendered = renderStats({ ...LIVE_PAYLOAD, live_listings: 7 }, NOW);

    expect(rendered).toContain("not interpreted by this tool");
    expect(rendered).toContain("live_listings: 7");
  });
});

describe("the stats tool over the protocol", () => {
  it("is keyless, and identifies itself on the wire", async () => {
    const { impl, calls } = routeFetch({ "/stats.json": { body: LIVE_PAYLOAD } });
    vi.stubGlobal("fetch", impl);

    const { text, isError } = await callStats();

    expect(isError).toBe(false);
    expect(text).toContain("cogDepot marketplace statistics");
    const call = calls.find((c) => c.url.includes("/stats.json"));
    expect(call?.url).toBe("https://api.cogdepot.com/stats.json");
    expect(call?.userAgent).toMatch(/^cogdepot-mcp(-remote)?\/\d+\.\d+\.\d+( \(ci\))?$/);
  });

  it("attaches no credential, even though the server was built without one", async () => {
    const seen: Record<string, string>[] = [];
    const capture = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(Object.fromEntries(new Headers((init?.headers ?? {}) as HeadersInit)));
      return new Response(JSON.stringify(LIVE_PAYLOAD), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", capture);

    await callStats();

    expect(seen[0]).not.toHaveProperty("x-api-key");
    expect(seen[0]).not.toHaveProperty("authorization");
  });

  it("reports a rate limit as retryable rather than as an empty market", async () => {
    const { impl } = routeFetch({ "/stats.json": { status: 429, body: {} } });
    vi.stubGlobal("fetch", impl);

    const { text, isError } = await callStats();

    expect(isError).toBe(true);
    expect(text).toContain("rate limited");
    expect(text).not.toContain("Do not retry");
  });

  it("refuses an HTML body rather than reporting a marketplace with no figures", async () => {
    const { impl } = routeFetch({ "/stats.json": { raw: "<!doctype html><title>Oops</title>" } });
    vi.stubGlobal("fetch", impl);

    const { text, isError } = await callStats();

    expect(isError).toBe(true);
    expect(text).toContain("did not return a statistics object");
  });

  it("reports an unreachable endpoint as a network error, not an empty market", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.cogdepot.com");
    }));

    const { text, isError } = await callStats();

    expect(isError).toBe(true);
    expect(text).toContain("Could not reach");
    expect(text).toContain("ENOTFOUND");
    expect(text).not.toContain("NOT STATED");
  });

  it("surfaces a server error as retryable", async () => {
    const { impl } = routeFetch({ "/stats.json": { status: 503, body: {} } });
    vi.stubGlobal("fetch", impl);

    const { text, isError } = await callStats();

    expect(isError).toBe(true);
    expect(text).toContain("503");
    expect(text).not.toContain("Do not retry");
  });
});
