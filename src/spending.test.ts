import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { buildServer } from "./core.js";
import { resetFactsCacheForTesting } from "./facts.js";
import {
  TOOL_BROWSE_FEED,
  TOOL_CLOSE_THREAD,
  TOOL_FINALIZE_DEAL,
  TOOL_GET_LISTING,
  TOOL_LIST_LISTING_THREADS,
  TOOL_OPEN_THREAD,
  TOOL_POST_LISTING,
  TOOL_SUBMIT_OFFER,
} from "./strings.js";

/**
 * The tools that spend the user's money.
 *
 * These shipped only after the gate in front of them turned out to be a
 * design-time note that had hardened into a citation. What replaced the gate is
 * enforced here: a stated price, a truthful annotation, an idempotency key on
 * anything that moves credits, and no raw uUSD crossing the boundary in either
 * direction.
 */

const KEY = "test-key";

const DISCOVERY = {
  apiBaseUrl: "https://api.cogdepot.com",
  credits: { meteredCall: "1 credit ($0.0005) per billable request" },
};

/** Records method, headers and parsed body so a test can assert what was sent. */
function routeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const match = Object.keys(routes).find((path) => url.includes(path));
    const route = match ? routes[match] : undefined;
    if (!route) return new Response(JSON.stringify({ reason: "not_found" }), { status: 404 });
    return new Response(route.status === 204 ? null : JSON.stringify(route.body ?? {}), {
      status: route.status,
      headers: { "content-type": "application/json" },
    });
  });
  return { impl, calls };
}

async function connect() {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([buildServer(KEY).connect(st), client.connect(ct)]);
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

describe("what a model is told before it spends", () => {
  it.each([
    [TOOL_BROWSE_FEED, /1 credit/i],
    [TOOL_GET_LISTING, /1 credit/i],
    [TOOL_POST_LISTING, /201 credits/i],
    [TOOL_OPEN_THREAD, /2,000-credit|2,000 credit/i],
    [TOOL_FINALIZE_DEAL, /2,000 credits/i],
  ])("%s states its price in the description", async (name, pattern) => {
    vi.stubGlobal("fetch", routeFetch({ "cogdepot.json": { status: 200, body: DISCOVERY } }).impl);

    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === name);

    expect(tool?.description).toMatch(pattern);
    await close();
  });

  it.each([TOOL_BROWSE_FEED, TOOL_GET_LISTING, TOOL_POST_LISTING, TOOL_OPEN_THREAD, TOOL_FINALIZE_DEAL])(
    "%s does not claim to be read-only while charging for the call",
    async (name) => {
      // A metered GET still debits a credit. readOnlyHint drives host
      // auto-permissions, so claiming it here spends money without a prompt.
      vi.stubGlobal("fetch", routeFetch({ "cogdepot.json": { status: 200, body: DISCOVERY } }).impl);

      const { client, close } = await connect();
      const { tools } = await client.listTools();

      expect(tools.find((t) => t.name === name)?.annotations?.readOnlyHint).toBe(false);
      await close();
    },
  );

  it.each([TOOL_FINALIZE_DEAL, TOOL_CLOSE_THREAD])(
    "%s declares itself destructive, because it cannot be undone",
    async (name) => {
      vi.stubGlobal("fetch", routeFetch({ "cogdepot.json": { status: 200, body: DISCOVERY } }).impl);

      const { client, close } = await connect();
      const { tools } = await client.listTools();

      expect(tools.find((t) => t.name === name)?.annotations?.destructiveHint).toBe(true);
      await close();
    },
  );

  it("warns that finalize ends the anonymity permanently", async () => {
    // The credit cost is the smaller half. Finalizing releases both parties'
    // contact details and cannot be walked back.
    vi.stubGlobal("fetch", routeFetch({ "cogdepot.json": { status: 200, body: DISCOVERY } }).impl);

    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const finalize = tools.find((t) => t.name === TOOL_FINALIZE_DEAL);

    expect(finalize?.description).toMatch(/cannot be undone/i);
    expect(finalize?.description).toMatch(/contact details|anonymity/i);
    await close();
  });
});

describe("posting a listing", () => {
  it("takes dollars and sends uUSD, so no model ever types a micro figure", async () => {
    // The output rule has an input twin: a model asked for price_micro types
    // 50 meaning $50 and prices the work at $0.00005.
    const { impl, calls } = routeFetch({
      "cogdepot.json": { status: 200, body: DISCOVERY },
      "/v1/listings": { status: 200, body: { id: "l-1", title: "Weekly scan", price_micro: 12500000 } },
    });
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect();
    const { isError } = await callText(client, TOOL_POST_LISTING, {
      title: "Weekly scan",
      category: "research",
      listing_type: "sell",
      price_usd: 12.5,
      body: "A weekly competitor scan delivered as structured JSON.",
    });

    expect(isError).toBe(false);
    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as Record<string, unknown>)["price_micro"]).toBe(12_500_000);
    expect(post?.body).not.toHaveProperty("price_usd");
    await close();
  });

  it("rounds a sub-micro price rather than silently making it free", async () => {
    const { impl, calls } = routeFetch({
      "cogdepot.json": { status: 200, body: DISCOVERY },
      "/v1/listings": { status: 200, body: { id: "l-1" } },
    });
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect();
    await callText(client, TOOL_POST_LISTING, {
      title: "t",
      category: "research",
      listing_type: "sell",
      price_usd: 0.0000004,
      body: "b",
    });

    const post = calls.find((c) => c.method === "POST");
    expect((post?.body as Record<string, unknown>)["price_micro"]).toBe(0);
    await close();
  });

  it("sends an idempotency key and hands it back for a safe retry", async () => {
    const { impl, calls } = routeFetch({
      "cogdepot.json": { status: 200, body: DISCOVERY },
      "/v1/listings": { status: 200, body: { id: "l-1" } },
    });
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect();
    const { text } = await callText(client, TOOL_POST_LISTING, {
      title: "t",
      category: "research",
      listing_type: "sell",
      price_usd: 1,
      body: "b",
    });

    const sent = calls.find((c) => c.method === "POST")?.headers["Idempotency-Key"];
    expect(sent).toMatch(/^[0-9a-f-]{36}$/);
    expect(text).toContain(sent as string);
    await close();
  });

  it("reuses a caller-supplied key instead of minting a new one", async () => {
    const { impl, calls } = routeFetch({
      "cogdepot.json": { status: 200, body: DISCOVERY },
      "/v1/listings": { status: 200, body: { id: "l-1" } },
    });
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect();
    await callText(client, TOOL_POST_LISTING, {
      title: "t",
      category: "research",
      listing_type: "sell",
      price_usd: 1,
      body: "b",
      idempotency_key: "caller-supplied-key",
    });

    expect(calls.find((c) => c.method === "POST")?.headers["Idempotency-Key"]).toBe(
      "caller-supplied-key",
    );
    await close();
  });

  it("separates the posting fee from the asking price in the confirmation", async () => {
    // A seller reading "charged 201 credits" next to a $12.50 listing must not
    // conclude the $12.50 was taken from them.
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/listings": { status: 200, body: { id: "l-1" } },
      }).impl,
    );

    const { client, close } = await connect();
    const { text } = await callText(client, TOOL_POST_LISTING, {
      title: "t",
      category: "research",
      listing_type: "sell",
      price_usd: 12.5,
      body: "b",
    });

    expect(text).toContain("201 credits");
    expect(text).toMatch(/\$12\.50.*not charged to you/s);
    await close();
  });
});

describe("browsing the feed", () => {
  it("passes filters and paging through as query parameters", async () => {
    const { impl, calls } = routeFetch({
      "cogdepot.json": { status: 200, body: DISCOVERY },
      "/v1/feed": { status: 200, body: { listings: [] } },
    });
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect();
    await callText(client, TOOL_BROWSE_FEED, {
      limit: 50,
      category: "research",
      type: "sell",
      cursor: "abc",
    });

    const feed = calls.find((c) => c.url.includes("/v1/feed"))?.url ?? "";
    expect(feed).toContain("limit=50");
    expect(feed).toContain("category=research");
    expect(feed).toContain("type=sell");
    expect(feed).toContain("cursor=abc");
    await close();
  });

  it("says another page costs another credit rather than just handing over a cursor", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/feed": {
          status: 200,
          body: { listings: [{ id: "a", title: "x", price_micro: 1000000 }], next_cursor: "n-2" },
        },
      }).impl,
    );

    const { client, close } = await connect();
    const { text } = await callText(client, TOOL_BROWSE_FEED);

    expect(text).toContain("n-2");
    expect(text).toMatch(/another credit/i);
    await close();
  });

  it("says plainly when the feed is exhausted", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/feed": { status: 200, body: { listings: [] } },
      }).impl,
    );

    const { client, close } = await connect();
    const { text } = await callText(client, TOOL_BROWSE_FEED);

    expect(text).toMatch(/end of the feed/i);
    await close();
  });

  it("does not attach the preview's sampling caveat to a real search", async () => {
    // The caveat exists because the preview cannot search. The feed can, so
    // repeating it would undercut a result the user paid for.
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/feed": { status: 200, body: { listings: [] } },
      }).impl,
    );

    const { client, close } = await connect();
    const { text } = await callText(client, TOOL_BROWSE_FEED);

    expect(text).not.toMatch(/capped at 20/i);
    await close();
  });

  it("gives a full listing's description its own section", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/listings/l-1": {
          status: 200,
          body: { id: "l-1", title: "Weekly scan", price_micro: 1000000, body: "## Scope\nEverything." },
        },
      }).impl,
    );

    const { client, close } = await connect();
    const { text } = await callText(client, TOOL_GET_LISTING, { listing_id: "l-1" });

    expect(text).toContain("## Description");
    expect(text).toContain("Everything.");
    expect(text).toContain("2,000 credits ($1.00)");
    await close();
  });
});

describe("the negotiation path", () => {
  it("states the hold and how to get it back when a thread opens", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/listings/l-1/threads": { status: 200, body: { id: "t-1", status: "open" } },
      }).impl,
    );

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_OPEN_THREAD, {
      listing_id: "l-1",
      diff: "Offering $8.00 with a 14-day window.",
    });

    expect(isError).toBe(false);
    expect(text).toMatch(/2,000 credits.*held/is);
    expect(text).toMatch(/released if the thread is closed/i);
    await close();
  });

  it("warns that the standing diff is what a counterparty would accept", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/threads/t-1/offers": { status: 200, body: { id: "t-1" } },
      }).impl,
    );

    const { client, close } = await connect();
    const { text } = await callText(client, TOOL_SUBMIT_OFFER, {
      thread_id: "t-1",
      diff: "$9.00 and I hold the window.",
    });

    expect(text).toMatch(/standing diff/i);
    expect(text).toMatch(/willing to be held to/i);
    await close();
  });

  it("tells the caller the hold came back after closing", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/threads/t-1/close": { status: 204 },
      }).impl,
    );

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_CLOSE_THREAD, { thread_id: "t-1" });

    expect(isError).toBe(false);
    expect(text).toMatch(/released back to spendable/i);
    expect(text).toMatch(/cannot be reopened/i);
    await close();
  });

  it("reports the reveal and the purge window when a deal seals", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/threads/t-1/finalize": {
          status: 200,
          body: {
            id: "d-1",
            reveal: { endpoint: "https://counterparty.example/agent", contact: "ops@example.com" },
          },
        },
      }).impl,
    );

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_FINALIZE_DEAL, { thread_id: "t-1" });

    expect(isError).toBe(false);
    expect(text).toContain("https://counterparty.example/agent");
    expect(text).toMatch(/purged 7 days/i);
    expect(text).toMatch(/2,000 credits.*from each side/is);
    await close();
  });

  it.each([
    [TOOL_OPEN_THREAD, { listing_id: "l-1", diff: "d" }, "/v1/listings/l-1/threads"],
    [TOOL_SUBMIT_OFFER, { thread_id: "t-1", diff: "d" }, "/v1/threads/t-1/offers"],
    [TOOL_CLOSE_THREAD, { thread_id: "t-1" }, "/v1/threads/t-1/close"],
    [TOOL_FINALIZE_DEAL, { thread_id: "t-1" }, "/v1/threads/t-1/finalize"],
  ])("%s sends an idempotency key", async (name, args, path) => {
    // A finalize whose response was lost must be retryable without charging a
    // second $1.00. Without the key there is no safe move.
    const { impl, calls } = routeFetch({
      "cogdepot.json": { status: 200, body: DISCOVERY },
      [path]: { status: 200, body: { id: "x" } },
    });
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect();
    await callText(client, name, args);

    const sent = calls.find((c) => c.url.includes(path))?.headers["Idempotency-Key"];
    expect(sent).toMatch(/^[0-9a-f-]{36}$/);
    await close();
  });

  it("surfaces an insufficient-funds refusal with the shortfall", async () => {
    // The one failure a spending tool must explain rather than merely report.
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        "/v1/listings/l-1/threads": {
          status: 402,
          body: { reason: "insufficient_funds_self", creditsRemaining: 500, creditsRequired: 2000 },
        },
      }).impl,
    );

    const { client, close } = await connect();
    const { text, isError } = await callText(client, TOOL_OPEN_THREAD, {
      listing_id: "l-1",
      diff: "d",
    });

    expect(isError).toBe(true);
    expect(text).toContain("1500 short");
    await close();
  });

  it.each([
    [TOOL_BROWSE_FEED, {}, "/v1/feed"],
    [TOOL_GET_LISTING, { listing_id: "l-1" }, "/v1/listings/l-1"],
    [
      TOOL_POST_LISTING,
      { title: "t", category: "c", listing_type: "sell", price_usd: 1, body: "b" },
      "/v1/listings",
    ],
    [TOOL_LIST_LISTING_THREADS, { listing_id: "l-1" }, "/v1/listings/l-1/threads"],
    [TOOL_SUBMIT_OFFER, { thread_id: "t-1", diff: "d" }, "/v1/threads/t-1/offers"],
    [TOOL_CLOSE_THREAD, { thread_id: "t-1" }, "/v1/threads/t-1/close"],
    [TOOL_FINALIZE_DEAL, { thread_id: "t-1" }, "/v1/threads/t-1/finalize"],
  ])("%s reports a server failure instead of claiming success", async (name, args, path) => {
    // A spending tool that swallows an error is the worst case available: the
    // caller believes the action happened and does not retry, or believes it
    // did not and pays again.
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: DISCOVERY },
        [path]: { status: 500, body: { detail: "upstream exploded" } },
      }).impl,
    );

    const { client, close } = await connect();
    const { text, isError } = await callText(client, name, args);

    expect(isError).toBe(true);
    expect(text).toContain("upstream exploded");
    await close();
  });

  it("lists the poster's inbox without spending anything", async () => {
    const { impl, calls } = routeFetch({
      "cogdepot.json": { status: 200, body: DISCOVERY },
      "/v1/listings/l-1/threads": { status: 200, body: { threads: [] } },
    });
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect();
    const { isError } = await callText(client, TOOL_LIST_LISTING_THREADS, { listing_id: "l-1" });

    expect(isError).toBe(false);
    expect(calls.find((c) => c.url.includes("/v1/listings/l-1/threads"))?.method).toBe("GET");
    await close();
  });
});
