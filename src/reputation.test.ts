import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { buildServer } from "./core.js";
import { resetFactsCacheForTesting } from "./facts.js";
import { TOOL_GET_REPUTATION } from "./strings.js";

/**
 * The keyless reputation lookup.
 *
 * Most of what is asserted here is honesty rather than plumbing. The endpoint
 * returns a number that looks like a perfect score for an account that has never
 * traded, and the single job this tool has beyond fetching is to make sure a
 * model cannot report that number without also seeing that it was never earned.
 */

const DISCOVERY = {
  apiBaseUrl: "https://api.cogdepot.com",
  credits: { meteredCall: "1 credit ($0.0005) per billable request" },
};

/** A brand-new account: seeded 5.0 in both roles, nothing behind it. */
const WARM_START_RECORD = {
  handle: "a3f19c02b7e4",
  seller: {
    rating_sum: 5,
    rating_count: 1,
    finalized_count: 0,
    non_delivery_count: 0,
    warm_start: true,
  },
  buyer: {
    rating_sum: 5,
    rating_count: 1,
    finalized_count: 0,
    non_delivery_count: 0,
    warm_start: true,
  },
  funded: false,
  domain_verified: false,
  as_of: "2026-08-21T12:00:00Z",
};

/** An account with a real seller record and an untouched buyer side. */
const EARNED_RECORD = {
  handle: "9d3a01d6b588",
  seller: {
    rating_sum: 47,
    rating_count: 10,
    finalized_count: 9,
    non_delivery_count: 1,
    warm_start: false,
  },
  buyer: {
    rating_sum: 5,
    rating_count: 1,
    finalized_count: 0,
    non_delivery_count: 0,
    warm_start: true,
  },
  funded: true,
  domain_verified: true,
  as_of: "2026-08-21T12:00:00Z",
};

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

describe("the keyless reputation lookup", () => {
  it("is offered without a key, which is the whole point of it", async () => {
    vi.stubGlobal("fetch", routeFetch({ "cogdepot.json": { status: 200, body: DISCOVERY } }).impl);

    const { client, close } = await connect();
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toContain(TOOL_GET_REPUTATION);
    await close();
  });

  it("sends no credential, even when one is configured", async () => {
    // The endpoint takes no key, and attaching one would tell cogDepot which
    // account is asking about whom - a disclosure the route is designed not to
    // require. A key being present in the environment must not change that.
    const { impl, calls } = routeFetch({
      "cogdepot.json": { status: 200, body: DISCOVERY },
      "/v1/reputation/": { status: 200, body: EARNED_RECORD },
    });
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect("cogd_live_akeythatexists");
    await callText(client, TOOL_GET_REPUTATION, { handle: "9d3a01d6b588" });

    const call = calls.find((c) => c.url.includes("/v1/reputation/"));
    expect(call).toBeDefined();
    const headerNames = Object.keys(call?.headers ?? {}).map((h) => h.toLowerCase());
    expect(headerNames).not.toContain("x-api-key");
    expect(headerNames).not.toContain("authorization");
    await close();
  });

  it("says warm start out loud rather than reporting a 5.0", async () => {
    // The assertion that matters most in this file. A seeded account renders as
    // a perfect score; if the caveat is ever dropped, a model will report that
    // score as a track record and this test is what stops it shipping.
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/reputation/": { status: 200, body: WARM_START_RECORD },
      }).impl,
    );

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_GET_REPUTATION, {
      handle: "a3f19c02b7e4",
    });

    expect(isError).toBe(false);
    expect(text).toContain("5.0");
    expect(text).toContain("WARM START");
    expect(text).toContain("was not earned");
    // Both roles are seeded here, so the record is absent rather than bad, and
    // the tool must say which.
    expect(text).toContain("no record of any kind");
    await close();
  });

  it("keeps the two roles apart", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/reputation/": { status: 200, body: EARNED_RECORD },
      }).impl,
    );

    const { client, close } = await connect();
    const { text } = await callText(client, TOOL_GET_REPUTATION, { handle: "9d3a01d6b588" });

    expect(text).toContain("As a seller:");
    expect(text).toContain("As a buyer:");
    // 47/10 = 4.7 earned on the sell side; the buy side is still a warm start.
    expect(text).toContain("4.7");
    expect(text).toContain("completed deals: 9");
    expect(text).toContain("WARM START");
    // An earned record must NOT get the absent-record line.
    expect(text).not.toContain("no record of any kind");
    await close();
  });

  it("treats a missing warm_start as a warm start, not as an earned record", async () => {
    // Over-caveating is the honest failure. If the API ever stopped sending the
    // flag, defaulting it false would silently upgrade every seeded account into
    // a track record.
    const noFlag = {
      ...WARM_START_RECORD,
      seller: { rating_sum: 5, rating_count: 1, finalized_count: 0, non_delivery_count: 0 },
    };
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/reputation/": { status: 200, body: noFlag },
      }).impl,
    );

    const { client, close } = await connect();
    const { text } = await callText(client, TOOL_GET_REPUTATION, { handle: "a3f19c02b7e4" });

    expect(text).toContain("WARM START");
    await close();
  });

  it("refuses a malformed handle without a round trip", async () => {
    // A model that reached for a listing id or an account uuid should be told
    // what a handle is, not handed a 404 it will read as "this agent does not
    // exist".
    const { impl, calls } = routeFetch({ "cogdepot.json": { status: 200, body: DISCOVERY } });
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_GET_REPUTATION, {
      handle: "5139e0f2-6af6-4e4e-a05c-f9587cdd06ce",
    });

    expect(isError).toBe(true);
    expect(text).toContain("not a cogDepot handle");
    expect(calls.some((c) => c.url.includes("/v1/reputation/"))).toBe(false);
    await close();
  });

  it("normalises case and surrounding whitespace", async () => {
    const { impl, calls } = routeFetch({
      "cogdepot.json": { status: 200, body: DISCOVERY },
      "/v1/reputation/": { status: 200, body: EARNED_RECORD },
    });
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect();
    await callText(client, TOOL_GET_REPUTATION, { handle: "  9D3A01D6B588 " });

    const call = calls.find((c) => c.url.includes("/v1/reputation/"));
    expect(call?.url).toContain("/v1/reputation/9d3a01d6b588");
    await close();
  });

  it("does not claim an unknown handle proves the agent is absent", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/reputation/": { status: 404, body: { reason: "not_found" } },
      }).impl,
    );

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_GET_REPUTATION, {
      handle: "a3f19c02b7e4",
    });

    expect(isError).toBe(true);
    expect(text).toContain("mistyped");
    await close();
  });

  it("reports a rate-limit refusal as temporary and not key-fixable", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/reputation/": { status: 429, body: { reason: "rate_limited" } },
      }).impl,
    );

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_GET_REPUTATION, {
      handle: "a3f19c02b7e4",
    });

    expect(isError).toBe(true);
    expect(text).toContain("rate limited");
    expect(text).toContain("takes none");
    await close();
  });

  it("degrades to a stated failure when the response is not JSON", async () => {
    // An HTML error page must not become a confident empty record that reads as
    // "this agent has no history".
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/reputation/": { status: 200, raw: "<html>gateway timeout</html>" },
      }).impl,
    );

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_GET_REPUTATION, {
      handle: "a3f19c02b7e4",
    });

    expect(isError).toBe(true);
    expect(text).toContain("did not return a reputation object");
    await close();
  });

  it("reports a server error as retryable rather than as an empty record", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/reputation/": { status: 503, body: { reason: "unavailable" } },
      }).impl,
    );

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_GET_REPUTATION, {
      handle: "a3f19c02b7e4",
    });

    expect(isError).toBe(true);
    expect(text).toContain("503");
    await close();
  });

  it("surfaces a network failure rather than swallowing it", async () => {
    const impl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("cogdepot.json")) {
        return new Response(JSON.stringify(DISCOVERY), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error("socket hang up");
    });
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_GET_REPUTATION, {
      handle: "a3f19c02b7e4",
    });

    expect(isError).toBe(true);
    expect(text).toContain("socket hang up");
    await close();
  });

  it("survives a body missing the facets entirely", async () => {
    // Validate at the boundary. A response that parsed as JSON but carried no
    // facets must render as zeroes with the caveat on, not throw - and "no
    // ratings" is the honest rendering of a count of zero, since dividing by it
    // would produce NaN.
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/reputation/": { status: 200, body: { handle: "a3f19c02b7e4" } },
      }).impl,
    );

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_GET_REPUTATION, {
      handle: "a3f19c02b7e4",
    });

    expect(isError).toBe(false);
    expect(text).toContain("no ratings");
    expect(text).not.toContain("NaN");
    expect(text).toContain("WARM START");
    // No as_of in the body, so no "Read at" line should be invented.
    expect(text).not.toContain("Read at:");
    // Absent funding and domain proof must read as absent, never as present.
    expect(text).toContain("Funded with real money: no");
    expect(text).toContain("Domain verified: no");
    await close();
  });

  it("throws a non-Error rejection through as a stated network failure", async () => {
    const impl = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("cogdepot.json")) {
        return new Response(JSON.stringify(DISCOVERY), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // eslint-disable-next-line no-throw-literal
      throw "connection reset";
    });
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_GET_REPUTATION, {
      handle: "a3f19c02b7e4",
    });

    expect(isError).toBe(true);
    expect(text).toContain("connection reset");
    await close();
  });

  it("is annotated read-only, which it genuinely is", async () => {
    // Unlike cogdepot_get_account, which settles lapsed escrow holds, and unlike
    // the metered reads, which debit a credit. The hints drive host
    // auto-permissions, so a wrong one here matters.
    vi.stubGlobal("fetch", routeFetch({ "cogdepot.json": { status: 200, body: DISCOVERY } }).impl);

    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === TOOL_GET_REPUTATION);

    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.annotations?.destructiveHint).toBe(false);
    await close();
  });
});
