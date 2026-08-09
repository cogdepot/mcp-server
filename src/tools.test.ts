import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { buildServer } from "./core.js";
import { resetFactsCacheForTesting } from "./facts.js";
import {
  TOOL_GET_ACCOUNT,
  TOOL_GET_DEAL,
  TOOL_GET_DOMAIN_CHALLENGE,
  TOOL_GET_THREAD,
  TOOL_RATE_DEAL,
  TOOL_UPDATE_PROFILE,
  TOOL_VERIFY_DOMAIN,
} from "./strings.js";

const KEY = "test-key";

/** Routes a mocked fetch by path so one handler serves the whole suite. */
function routeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    const match = Object.keys(routes).find((path) => url.includes(path));
    const route = match ? routes[match] : undefined;
    if (!route) return new Response(JSON.stringify({ reason: "not_found" }), { status: 404 });
    return new Response(route.status === 204 ? null : JSON.stringify(route.body ?? {}), {
      status: route.status,
      headers: { "content-type": "application/json" },
    });
  });
}

async function connectWithKey() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer(KEY);
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => client.close() };
}

async function callText(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");
  return { text, isError: Boolean(result.isError) };
}

const DISCOVERY = {
  apiBaseUrl: "https://api.cogdepot.com",
  credits: { meteredCall: "1 credit ($0.0005) per billable request", topUp: "POST /dashboard/credits" },
};

beforeEach(() => {
  resetFactsCacheForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("keyed tools", () => {
  it("registers the keyed tools only when a key is present", async () => {
    vi.stubGlobal("fetch", routeFetch({ "cogdepot.json": { status: 200, body: DISCOVERY } }));

    const [ct, st] = InMemoryTransport.createLinkedPair();
    const keyless = buildServer();
    const client = new Client({ name: "t", version: "0" });
    await Promise.all([keyless.connect(st), client.connect(ct)]);
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).not.toContain(TOOL_GET_ACCOUNT);
    await client.close();
  });

  it("renders the account without leaking uUSD", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/account": {
          status: 200,
          body: {
            balance_micro: 1_000_000,
            held_micro: 0,
            status: "active",
            reputation: { buyer: { rating_sum: 5, rating_count: 1, finalized_count: 0 } },
          },
        },
      }),
    );

    const { client, close } = await connectWithKey();
    const { text, isError } = await callText(client, TOOL_GET_ACCOUNT);

    expect(isError).toBe(false);
    expect(text).toContain("20,000 credits");
    expect(text).toContain("($1.00)");
    expect(text).not.toMatch(/_micro/);
    expect(text).toMatch(/synthetic/);
    await close();
  });

  it("writes both profile routes in one tool call", async () => {
    const fetchImpl = routeFetch({
      "cogdepot.json": { status: 200, body: DISCOVERY },
      "/v1/account/contact": { status: 204 },
      "/v1/account/route": { status: 204 },
    });
    vi.stubGlobal("fetch", fetchImpl);

    const { client, close } = await connectWithKey();
    const { text, isError } = await callText(client, TOOL_UPDATE_PROFILE, {
      contact_name: "cogDepot",
      contact_email: "akashy@cogdepot.com",
      deal_route: "https://cogdepot.com/deal",
    });

    expect(isError).toBe(false);
    expect(text).toMatch(/Profile updated/);
    const called = fetchImpl.mock.calls.map((c) => String(c[0]));
    expect(called.some((u) => u.includes("/v1/account/contact"))).toBe(true);
    expect(called.some((u) => u.includes("/v1/account/route"))).toBe(true);
    await close();
  });

  it("surfaces a 402 as a shortfall, never as the x402 offer array", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/account/domain/verify": {
          status: 402,
          body: {
            reason: "insufficient_funds_self",
            creditsRemaining: 0,
            creditsRequired: 1,
            accepts: [{ payTo: "0xdeadbeef", network: "base" }],
          },
        },
      }),
    );

    const { client, close } = await connectWithKey();
    const { text, isError } = await callText(client, TOOL_VERIFY_DOMAIN);

    expect(isError).toBe(true);
    expect(text).toContain("1 short");
    expect(text).not.toContain("0xdeadbeef");
    await close();
  });

  it("reports a successful domain verification and the grant it paid", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/account/domain/verify": {
          status: 200,
          body: { verified: true, domain: "example.com", credits_granted: 20000 },
        },
      }),
    );

    const { client, close } = await connectWithKey();
    const { text, isError } = await callText(client, TOOL_VERIFY_DOMAIN);

    expect(isError).toBe(false);
    expect(text).toContain("Domain verified");
    expect(text).toContain("20000");
    await close();
  });

  it("returns the domain challenge", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/account/domain": { status: 200, body: { token: "abc123", host: "example.com" } },
      }),
    );

    const { client, close } = await connectWithKey();
    const { text } = await callText(client, TOOL_GET_DOMAIN_CHALLENGE);

    expect(text).toContain("abc123");
    await close();
  });

  it("reads a thread and a deal, and warns that a deal is purged after 7 days", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/threads/": { status: 200, body: { status: "open", offers: [{ amount: 5 }] } },
        "/v1/deals/": { status: 200, body: { deal_id: "d1", endpoint: "https://x" } },
      }),
    );

    const { client, close } = await connectWithKey();

    const thread = await callText(client, TOOL_GET_THREAD, { thread_id: "t1" });
    expect(thread.text).toContain("open");

    const deal = await callText(client, TOOL_GET_DEAL, { deal_id: "d1" });
    expect(deal.text).toMatch(/purged/);
    await close();
  });

  it("confirms a rating is permanent, because it cannot be withdrawn", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/ratings": { status: 204 },
      }),
    );

    const { client, close } = await connectWithKey();
    const { text, isError } = await callText(client, TOOL_RATE_DEAL, { deal_id: "d1", score: 5 });

    expect(isError).toBe(false);
    expect(text).toMatch(/cannot be changed or withdrawn/);
    await close();
  });

  it("marks the rating tool destructive, since a rating is irreversible", async () => {
    vi.stubGlobal("fetch", routeFetch({ "cogdepot.json": { status: 200, body: DISCOVERY } }));

    const { client, close } = await connectWithKey();
    const { tools } = await client.listTools();
    const rate = tools.find((t) => t.name === TOOL_RATE_DEAL);

    expect(rate?.annotations?.destructiveHint).toBe(true);
    await close();
  });

  it("does not claim cogdepot_get_account is read-only, because it settles escrows", async () => {
    vi.stubGlobal("fetch", routeFetch({ "cogdepot.json": { status: 200, body: DISCOVERY } }));

    const { client, close } = await connectWithKey();
    const { tools } = await client.listTools();
    const account = tools.find((t) => t.name === TOOL_GET_ACCOUNT);

    expect(account?.annotations?.readOnlyHint).toBe(false);
    await close();
  });

  it("ships no fee-incurring tool while the eligibility question is open", async () => {
    vi.stubGlobal("fetch", routeFetch({ "cogdepot.json": { status: 200, body: DISCOVERY } }));

    const { client, close } = await connectWithKey();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    for (const gated of ["search_listings", "get_listing", "post_listing", "open_thread", "finalize_deal"]) {
      expect(names.some((n) => n.endsWith(gated))).toBe(false);
    }
    await close();
  });

  it("says so plainly when the API answers with no content at all", async () => {
    // A 204 on a GET is not a shape any of these endpoints promise, but an
    // empty render that looks like a successful answer is the worst outcome.
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/account": { status: 204 },
        "/v1/account/domain": { status: 204 },
        "/v1/threads/": { status: 204 },
        "/v1/deals/": { status: 204 },
      }),
    );

    const { client, close } = await connectWithKey();

    expect((await callText(client, TOOL_GET_ACCOUNT)).text).toMatch(/empty account record/);
    expect((await callText(client, TOOL_GET_DOMAIN_CHALLENGE)).text).toMatch(/no content/);
    expect((await callText(client, TOOL_GET_THREAD, { thread_id: "t" })).text).toMatch(/no content/);
    expect((await callText(client, TOOL_GET_DEAL, { deal_id: "d" })).text).toMatch(/no content/);
    await close();
  });

  it("renders nested and null fields without printing null or [object Object]", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/threads/": {
          status: 200,
          body: { status: "open", closed_at: null, terms: { price: 5, currency: "credits" } },
        },
      }),
    );

    const { client, close } = await connectWithKey();
    const { text } = await callText(client, TOOL_GET_THREAD, { thread_id: "t1" });

    expect(text).not.toContain("[object Object]");
    expect(text).not.toMatch(/closed_at/);
    expect(text).toContain('"price": 5');
    await close();
  });

  it("renders a reputation facet that is a bare value rather than an object", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/account": {
          status: 200,
          body: { balance_micro: 0, held_micro: 0, reputation: { funded: true } },
        },
      }),
    );

    const { client, close } = await connectWithKey();
    const { text } = await callText(client, TOOL_GET_ACCOUNT);

    expect(text).toContain("funded: true");
    await close();
  });

  it("passes contact_url through only when supplied", async () => {
    const fetchImpl = routeFetch({
      "cogdepot.json": { status: 200, body: DISCOVERY },
      "/v1/account/contact": { status: 204 },
      "/v1/account/route": { status: 204 },
    });
    vi.stubGlobal("fetch", fetchImpl);

    const { client, close } = await connectWithKey();
    await callText(client, TOOL_UPDATE_PROFILE, {
      contact_name: "n",
      contact_email: "e@example.com",
      deal_route: "https://example.com/d",
      contact_url: "https://example.com",
    });

    const contactCall = fetchImpl.mock.calls.find((c) => String(c[0]).includes("/contact"));
    expect(String((contactCall?.[1] as RequestInit)?.body)).toContain("contact_url");
    await close();
  });

  it("sends delivered only when the caller states it", async () => {
    const fetchImpl = routeFetch({
      "cogdepot.json": { status: 200, body: DISCOVERY },
      "/ratings": { status: 204 },
    });
    vi.stubGlobal("fetch", fetchImpl);

    const { client, close } = await connectWithKey();
    await callText(client, TOOL_RATE_DEAL, { deal_id: "d1", score: 4, delivered: false });

    const body = String((fetchImpl.mock.calls.at(-1)?.[1] as RequestInit)?.body);
    expect(body).toContain('"delivered":false');
    await close();
  });

  it("surfaces a failure on every keyed tool rather than pretending it worked", async () => {
    // Each handler has its own catch. One that swallowed an error and returned
    // a cheerful message would be invisible until a user acted on it, so every
    // one is exercised against a failing API.
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/account/contact": { status: 500, body: { reason: "internal", detail: "boom" } },
        "/v1/account/domain": { status: 500, body: { reason: "internal", detail: "boom" } },
        "/v1/account": { status: 500, body: { reason: "internal", detail: "boom" } },
        "/v1/threads/": { status: 500, body: { reason: "internal", detail: "boom" } },
        "/v1/deals/": { status: 500, body: { reason: "internal", detail: "boom" } },
        "/ratings": { status: 500, body: { reason: "internal", detail: "boom" } },
      }),
    );

    const { client, close } = await connectWithKey();

    for (const [name, args] of [
      [TOOL_GET_ACCOUNT, {}],
      [TOOL_GET_DOMAIN_CHALLENGE, {}],
      [TOOL_VERIFY_DOMAIN, {}],
      [TOOL_GET_THREAD, { thread_id: "t" }],
      [TOOL_GET_DEAL, { deal_id: "d" }],
      [TOOL_RATE_DEAL, { deal_id: "d", score: 3 }],
      [
        TOOL_UPDATE_PROFILE,
        { contact_name: "n", contact_email: "e@e.com", deal_route: "https://e.com/d" },
      ],
    ] as const) {
      const { isError, text } = await callText(client, name, args as Record<string, unknown>);
      expect(isError, `${name} must report the failure`).toBe(true);
      expect(text).toContain("boom");
    }
    await close();
  });

  it("reports a 404 as not-found rather than an unexplained failure", async () => {
    vi.stubGlobal("fetch", routeFetch({ "cogdepot.json": { status: 200, body: DISCOVERY } }));

    const { client, close } = await connectWithKey();
    const { text, isError } = await callText(client, TOOL_GET_THREAD, { thread_id: "missing" });

    expect(isError).toBe(true);
    expect(text).toMatch(/Not found/i);
    await close();
  });
});
