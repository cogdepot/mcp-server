import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { buildServer } from "./core.js";
import { resetFactsCacheForTesting } from "./facts.js";
import { DEFAULT_PREVIEW_URL, TOOL_GET_MY_LISTINGS, TOOL_PREVIEW_LISTINGS } from "./strings.js";

/**
 * The listing tools.
 *
 * The preview is the only call in this package that leaves `api.cogdepot.com`
 * and the only one that must NOT carry the API key, so both properties are
 * asserted here rather than left to review.
 */

const DISCOVERY = {
  apiBaseUrl: "https://api.cogdepot.com",
  credits: { meteredCall: "1 credit ($0.0005) per billable request" },
  keylessPreview: { url: DEFAULT_PREVIEW_URL },
};

/** One live listing, in the exact shape the storefront serves today. */
const LISTING = {
  id: "5139e0f2-6af6-4e4e-a05c-f9587cdd06ce",
  status: "live",
  created_at: "2026-08-06T19:51:01Z",
  expires_at: 1786650661,
  poster_id: "9d3a01d6b588",
  title: "probe",
  category: "translation",
  listing_type: "sell",
  price_micro: 1000000,
  price_usd: "1.00",
};

/**
 * Routes by URL substring and records every request, so a test can assert what
 * was sent as well as what came back.
 */
function routeFetch(routes: Record<string, { status: number; body?: unknown; raw?: string }>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const match = Object.keys(routes).find((path) => url.includes(path));
    const route = match ? routes[match] : undefined;
    if (!route) return new Response(JSON.stringify({ reason: "not_found" }), { status: 404 });
    return new Response(route.raw ?? JSON.stringify(route.body ?? {}), {
      status: route.status,
      headers: { "content-type": route.raw ? "text/html" : "application/json" },
    });
  });
  return { impl, calls };
}

async function connect(apiKey?: string) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    buildServer(apiKey).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { client, close: () => client.close() };
}

async function callText(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");
  return { text, isError: Boolean(result.isError) };
}

beforeEach(() => {
  resetFactsCacheForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the keyless listing preview", () => {
  it("is offered without a key, which is the whole point of it", async () => {
    vi.stubGlobal("fetch", routeFetch({ "cogdepot.json": { status: 200, body: DISCOVERY } }).impl);

    const { client, close } = await connect();
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toContain(TOOL_PREVIEW_LISTINGS);
    await close();
  });

  it("renders a price in credits and dollars, never in uUSD", async () => {
    // The 0.1.2 defect in a new place: price_micro: 1000000 is $1.00 and 2,000
    // credits. Leaking the raw figure invites a model to reason about a million.
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/api/preview": { status: 200, body: { listings: [LISTING] } },
      }).impl,
    );

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_PREVIEW_LISTINGS);

    expect(isError).toBe(false);
    expect(text).toContain("2,000 credits ($1.00)");
    expect(text).not.toContain("1000000");
    expect(text).not.toContain("price_micro");
    await close();
  });

  it("turns the Unix expiry into a date rather than handing over an integer", async () => {
    // created_at is ISO and expires_at is Unix seconds, in the same object.
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/api/preview": { status: 200, body: { listings: [LISTING] } },
      }).impl,
    );

    const { client, close } = await connect();
    const { text } = await callText(client, TOOL_PREVIEW_LISTINGS);

    expect(text).toContain(new Date(1786650661 * 1000).toISOString());
    expect(text).not.toContain("1786650661");
    await close();
  });

  it("says it is a capped sample, so absence is not read as evidence", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/api/preview": { status: 200, body: { listings: [LISTING] } },
      }).impl,
    );

    const { client, close } = await connect();
    const { text } = await callText(client, TOOL_PREVIEW_LISTINGS);

    expect(text).toMatch(/NOT.*the full feed/s);
    expect(text).toMatch(/not evidence/i);
    await close();
  });

  it("never sends the API key to the storefront, even when one is configured", async () => {
    // The preview is the one surface a user can look at without cogDepot
    // learning which account is looking. Authenticating it would quietly remove
    // that property while every test above still passed.
    const { impl, calls } = routeFetch({
      "cogdepot.json": { status: 200, body: DISCOVERY },
      "/api/preview": { status: 200, body: { listings: [LISTING] } },
    });
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect("a-real-looking-key");
    await callText(client, TOOL_PREVIEW_LISTINGS);

    const previewCalls = calls.filter((c) => c.url.includes("/api/preview"));
    expect(previewCalls).toHaveLength(1);
    for (const call of previewCalls) {
      const headerNames = Object.keys(call.headers).map((h) => h.toLowerCase());
      expect(headerNames).not.toContain("x-api-key");
      expect(JSON.stringify(call.headers)).not.toContain("a-real-looking-key");
    }
    await close();
  });

  it("reports an empty market as empty, not as a failure", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/api/preview": { status: 200, body: { listings: [] } },
      }).impl,
    );

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_PREVIEW_LISTINGS);

    expect(isError).toBe(false);
    expect(text).toMatch(/not a failed call/i);
    await close();
  });

  it("does not report an HTML error page as an empty market", async () => {
    // The storefront is a web app, so a 200 carrying HTML is the realistic
    // failure. Rendering that as "no listings are live" would be a confident
    // wrong answer to the one question this tool exists to answer.
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/api/preview": { status: 200, raw: "<!doctype html><title>Oops</title>" },
      }).impl,
    );

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_PREVIEW_LISTINGS);

    expect(isError).toBe(true);
    expect(text).toMatch(/did not return a listings array/i);
    await close();
  });

  it("explains the per-IP rate limit rather than suggesting a key would help", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/api/preview": { status: 429, body: {} },
      }).impl,
    );

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_PREVIEW_LISTINGS);

    expect(isError).toBe(true);
    expect(text).toMatch(/rate limited per IP/i);
    expect(text).toMatch(/takes none/i);
    await close();
  });

  it("falls back to the built-in URL when the document states none", async () => {
    const { impl, calls } = routeFetch({
      "cogdepot.json": { status: 200, body: { apiBaseUrl: "https://api.cogdepot.com" } },
      "/api/preview": { status: 200, body: { listings: [LISTING] } },
    });
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect();
    const { isError } = await callText(client, TOOL_PREVIEW_LISTINGS);

    expect(isError).toBe(false);
    expect(calls.some((c) => c.url === DEFAULT_PREVIEW_URL)).toBe(true);
    await close();
  });

  it.each([
    ["https://evil.example.com/api/preview", "a foreign host"],
    ["https://evilcogdepot.com/api/preview", "a lookalike that only ends with the domain"],
    ["http://cogdepot.com/api/preview", "plain http"],
  ])("refuses %s (%s) rather than silently using the built-in URL", async (stated) => {
    // A stated-but-wrong value is a mistake worth stopping for, exactly as
    // COGDEPOT_API_BASE_URL treats one. Substituting the default would hide a
    // tampered document instead of reporting it.
    const { impl, calls } = routeFetch({
      "cogdepot.json": {
        status: 200,
        body: { ...DISCOVERY, keylessPreview: { url: stated } },
      },
      "/api/preview": { status: 200, body: { listings: [LISTING] } },
    });
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_PREVIEW_LISTINGS);

    expect(isError).toBe(true);
    expect(text).toMatch(/refusing to call it|not a valid URL/i);
    expect(calls.some((c) => c.url.includes("evil") || c.url.startsWith("http://"))).toBe(false);
    await close();
  });
});

describe("the preview's failure and edge shapes", () => {
  it("refuses a stated preview URL that is not a URL at all", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": {
          status: 200,
          body: { ...DISCOVERY, keylessPreview: { url: "not-a-url-at-all" } },
        },
      }).impl,
    );

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_PREVIEW_LISTINGS);

    expect(isError).toBe(true);
    expect(text).toMatch(/not a valid URL/i);
    await close();
  });

  it("reports an unreachable storefront as unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("cogdepot.json")) {
          return new Response(JSON.stringify(DISCOVERY), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new TypeError("connect ECONNREFUSED");
      }),
    );

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_PREVIEW_LISTINGS);

    expect(isError).toBe(true);
    expect(text).toMatch(/could not reach/i);
    expect(text).toContain("ECONNREFUSED");
    await close();
  });

  it("passes a server error through with its status", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/api/preview": { status: 503, body: {} },
      }).impl,
    );

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_PREVIEW_LISTINGS);

    expect(isError).toBe(true);
    expect(text).toContain("503");
    await close();
  });

  it("renders a listing that states almost nothing", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/api/preview": { status: 200, body: { listings: [{ id: "bare-1", status: "live" }] } },
      }).impl,
    );

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_PREVIEW_LISTINGS);

    expect(isError).toBe(false);
    expect(text).toContain("(untitled listing)");
    expect(text).toContain("bare-1");
    await close();
  });

  it("keeps a field this renderer has never heard of", async () => {
    // A listing growing a field must not silently lose it.
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/api/preview": {
          status: 200,
          body: { listings: [{ ...LISTING, fulfilment_window: "24h" }] },
        },
      }).impl,
    );

    const { client, close } = await connect();
    const { text } = await callText(client, TOOL_PREVIEW_LISTINGS);

    expect(text).toContain("fulfilment_window");
    expect(text).toContain("24h");
    await close();
  });

  it("does not repeat the dollar figure it already showed", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/api/preview": { status: 200, body: { listings: [LISTING] } },
      }).impl,
    );

    const { client, close } = await connect();
    const { text } = await callText(client, TOOL_PREVIEW_LISTINGS);

    expect(text).not.toContain("price_usd");
    await close();
  });

  it("still states a price when the API omits the dollar figure", async () => {
    const { price_usd: _dropped, ...withoutUsd } = LISTING;
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/api/preview": { status: 200, body: { listings: [withoutUsd] } },
      }).impl,
    );

    const { client, close } = await connect();
    const { text } = await callText(client, TOOL_PREVIEW_LISTINGS);

    expect(text).toContain("2,000 credits ($1.00)");
    await close();
  });

  it.each([
    [{ ...LISTING, price_micro: "1000000" }, "$1.00"],
    [{ ...LISTING, price_micro: "1000000", price_usd: undefined }, "1000000"],
  ])("does not invent a conversion from a non-numeric price", async (listing, expected) => {
    // Dividing a string by 500 yields NaN, and "NaN credits" is worse than
    // showing what the API actually said.
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/api/preview": { status: 200, body: { listings: [listing] } },
      }).impl,
    );

    const { client, close } = await connect();
    const { text } = await callText(client, TOOL_PREVIEW_LISTINGS);

    expect(text).toContain(expected);
    expect(text).not.toContain("NaN");
    await close();
  });

  it("leaves an already-readable expiry alone", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/api/preview": {
          status: 200,
          body: { listings: [{ ...LISTING, expires_at: "2026-09-01T00:00:00Z" }] },
        },
      }).impl,
    );

    const { client, close } = await connect();
    const { text } = await callText(client, TOOL_PREVIEW_LISTINGS);

    expect(text).toContain("2026-09-01T00:00:00Z");
    await close();
  });

  it("does not turn an unusable expiry into 1970", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/api/preview": { status: 200, body: { listings: [{ ...LISTING, expires_at: true }] } },
      }).impl,
    );

    const { client, close } = await connect();
    const { text } = await callText(client, TOOL_PREVIEW_LISTINGS);

    expect(text).not.toContain("1970");
    await close();
  });
});

describe("the account's own listings", () => {
  it("is not offered without a key", async () => {
    vi.stubGlobal("fetch", routeFetch({ "cogdepot.json": { status: 200, body: DISCOVERY } }).impl);

    const { client, close } = await connect();
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).not.toContain(TOOL_GET_MY_LISTINGS);
    await close();
  });

  it("renders the account's listings with credits and dollars", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/listings/mine": { status: 200, body: { listings: [LISTING] } },
      }).impl,
    );

    const { client, close } = await connect("test-key");
    const { text, isError } = await callText(client, TOOL_GET_MY_LISTINGS);

    expect(isError).toBe(false);
    expect(text).toContain("probe");
    expect(text).toContain("2,000 credits ($1.00)");
    await close();
  });

  it("accepts a bare array too, since the route is absent from the OpenAPI", async () => {
    // The response shape cannot be read off a published contract, so the parser
    // tolerates both wrappings rather than failing a free read over a key name.
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/listings/mine": { status: 200, body: [LISTING] },
      }).impl,
    );

    const { client, close } = await connect("test-key");
    const { text, isError } = await callText(client, TOOL_GET_MY_LISTINGS);

    expect(isError).toBe(false);
    expect(text).toContain("probe");
    await close();
  });

  it("points an empty account at the tool that posts, now that it ships", async () => {
    // This message said posting was "not available through this server yet"
    // until cogdepot_post_listing shipped, at which point it was a false claim
    // about the server's own tools. Caught against a fresh production account.
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/listings/mine": { status: 200, body: { listings: [] } },
      }).impl,
    );

    const { client, close } = await connect("test-key");
    const { text, isError } = await callText(client, TOOL_GET_MY_LISTINGS);

    expect(isError).toBe(false);
    expect(text).toMatch(/post one with cogdepot_post_listing/i);
    expect(text).not.toMatch(/not available through this server yet/i);
    await close();
  });

  it("surfaces an API failure rather than an empty list", async () => {
    // "You have no listings" and "the call failed" are opposite answers, and a
    // seller acting on the first when the second is true would post a duplicate.
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/listings/mine": { status: 401, body: { reason: "unauthorized" } },
      }).impl,
    );

    const { client, close } = await connect("stale-key");
    const { text, isError } = await callText(client, TOOL_GET_MY_LISTINGS);

    expect(isError).toBe(true);
    expect(text).toMatch(/no valid api key/i);
    await close();
  });

  it("reports an unrecognised body as no listings rather than failing a free read", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/listings/mine": { status: 200, body: { unexpected: "shape" } },
      }).impl,
    );

    const { client, close } = await connect("test-key");
    const { text, isError } = await callText(client, TOOL_GET_MY_LISTINGS);

    expect(isError).toBe(false);
    expect(text).toMatch(/has not posted any listings/i);
    await close();
  });

  it("does not carry the preview's sampling caveat, which does not apply", async () => {
    // This tool returns every listing the account has; warning that it might not
    // would make a seller distrust a complete answer.
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/listings/mine": { status: 200, body: { listings: [LISTING] } },
      }).impl,
    );

    const { client, close } = await connect("test-key");
    const { text } = await callText(client, TOOL_GET_MY_LISTINGS);

    expect(text).not.toMatch(/capped at 20/i);
    await close();
  });

  it("sends the API key, unlike the preview", async () => {
    const { impl, calls } = routeFetch({
      "cogdepot.json": { status: 200, body: DISCOVERY },
      "/v1/listings/mine": { status: 200, body: { listings: [LISTING] } },
    });
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect("test-key");
    await callText(client, TOOL_GET_MY_LISTINGS);

    const mine = calls.find((c) => c.url.includes("/v1/listings/mine"));
    expect(mine?.headers["x-api-key"]).toBe("test-key");
    await close();
  });
});
