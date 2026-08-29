import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { buildServer } from "./core.js";
import { resetFactsCacheForTesting } from "./facts.js";
import { isValidAgentCardUrl } from "./tools-account.js";
import { TOOL_UPDATE_PROFILE } from "./strings.js";

/**
 * The optional route declaration: route_protocol_binding and agent_card_url.
 *
 * Both are replace-on-write, which is the part a caller gets wrong. A route
 * write replaces the WHOLE declaration, so an agent that sets a binding once
 * and later updates only deal_route has silently cleared it. That behaviour is
 * the API's, not this server's, and the only thing this side can do about it is
 * send exactly what was asked for and say plainly what just happened.
 *
 * The agent card rules are stricter than "an https URL" and the API documents
 * none of them in its OpenAPI - the PUT declares a generic problem+json and
 * nothing else. So the cases below are the only written record of that rule on
 * this side of the boundary, and they are checked here rather than discovered
 * as a 400 by whoever calls the tool first.
 */

const KEY = "test-key";

const DISCOVERY = {
  apiBaseUrl: "https://api.cogdepot.com",
  credits: { meteredCall: "1 credit ($0.0005) per billable request" },
};

/** Records method and parsed body so a test can assert what was sent. */
function routeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({
      url,
      method: init?.method ?? "GET",
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

const OK = {
  "cogdepot.json": { status: 200, body: DISCOVERY },
  "/v1/account/contact": { status: 204 },
  "/v1/account/route": { status: 204 },
};

const BASE = {
  contact_name: "n",
  contact_email: "e@e.com",
  deal_route: "https://e.com/d",
};

/** The body of the route write, as it went to the wire. */
function routeBody(calls: { url: string; body: unknown }[]): Record<string, unknown> {
  const call = calls.find((c) => c.url.includes("/v1/account/route"));
  if (!call) throw new Error("no route write was made");
  return call.body as Record<string, unknown>;
}

function routeWrites(calls: { url: string }[]): number {
  return calls.filter((c) => c.url.includes("/v1/account/route")).length;
}

beforeEach(() => {
  resetFactsCacheForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the agent card URL rule", () => {
  it.each([
    "https://acme.example/.well-known/agent-card.json",
    "https://acme.example/card.json",
    "https://acme.example:8443/.well-known/agent-card.json",
  ])("accepts %s", (url) => {
    expect(isValidAgentCardUrl(url)).toBe(true);
  });

  it.each([
    ["a query string", "https://acme.example/card.json?v=2"],
    ["a fragment", "https://acme.example/card.json#top"],
    ["a trailing slash", "https://acme.example/card/"],
    ["a bare origin, whose path is a lone slash", "https://acme.example"],
    ["http rather than https", "http://acme.example/card.json"],
    ["localhost", "https://localhost/card.json"],
    ["a .localhost subdomain", "https://acme.localhost/card.json"],
    ["an IPv4 loopback", "https://127.0.0.1/card.json"],
    ["the unspecified address", "https://0.0.0.0/card.json"],
    ["a 10/8 private address", "https://10.1.2.3/card.json"],
    ["a 172.16/12 private address", "https://172.20.0.1/card.json"],
    ["a 192.168/16 private address", "https://192.168.1.1/card.json"],
    ["a link-local address", "https://169.254.1.1/card.json"],
    ["an IPv6 loopback", "https://[::1]/card.json"],
    ["an IPv6 link-local address", "https://[fe80::1]/card.json"],
    ["an IPv6 unique-local address", "https://[fd00::1]/card.json"],
    ["a string that is not a URL", "acme.example/card.json"],
  ])("rejects %s", (_why, url) => {
    expect(isValidAgentCardUrl(url)).toBe(false);
  });

  it("does not reject a public address that merely resembles a private one", () => {
    // 172.32 sits outside 172.16/12 and 11/8 is not private at all. A check
    // that matched on the first octet alone would refuse both.
    expect(isValidAgentCardUrl("https://172.32.0.1/card.json")).toBe(true);
    expect(isValidAgentCardUrl("https://11.0.0.1/card.json")).toBe(true);
  });
});

describe("the optional route declaration", () => {
  it("sends both declarations when they are given", async () => {
    const { impl, calls } = routeFetch(OK);
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect();
    const { isError, text } = await callText(client, TOOL_UPDATE_PROFILE, {
      ...BASE,
      route_protocol_binding: "HTTP+JSON",
      agent_card_url: "https://e.com/.well-known/agent-card.json",
    });

    expect(isError).toBe(false);
    expect(routeBody(calls)).toEqual({
      deal_route: "https://e.com/d",
      route_protocol_binding: "HTTP+JSON",
      agent_card_url: "https://e.com/.well-known/agent-card.json",
    });
    expect(text).toContain("HTTP+JSON");
    await close();
  });

  it("accepts the cogDepot webhook binding, which is a URI rather than a name", async () => {
    const { impl, calls } = routeFetch(OK);
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect();
    const { isError } = await callText(client, TOOL_UPDATE_PROFILE, {
      ...BASE,
      route_protocol_binding: "https://cogdepot.com/bindings/webhook-v1",
    });

    expect(isError).toBe(false);
    expect(routeBody(calls).route_protocol_binding).toBe(
      "https://cogdepot.com/bindings/webhook-v1",
    );
    await close();
  });

  it("omits an undeclared field entirely rather than sending null", async () => {
    // Replace-on-write: the API clears what is absent. An explicit null would be
    // a different request, and absence is what the caller's omission asked for.
    const { impl, calls } = routeFetch(OK);
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect();
    const { text } = await callText(client, TOOL_UPDATE_PROFILE, BASE);

    const body = routeBody(calls);
    expect(body).toEqual({ deal_route: "https://e.com/d" });
    expect("route_protocol_binding" in body).toBe(false);
    expect("agent_card_url" in body).toBe(false);
    // The caller is told, because this write just cleared anything set earlier.
    expect(text).toContain("no interface descriptor");
    expect(text).toContain("cleared");
    await close();
  });

  it("refuses an unrecognised binding at the boundary without writing the route", async () => {
    // HTTPS_JSON was the binding the API used to define on the operator's
    // behalf. It is not one of the three an operator may now declare, and a
    // caller working from the old shape is exactly who sends it.
    const { impl, calls } = routeFetch(OK);
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect();
    const { isError } = await callText(client, TOOL_UPDATE_PROFILE, {
      ...BASE,
      route_protocol_binding: "HTTPS_JSON",
    });

    expect(isError).toBe(true);
    expect(routeWrites(calls)).toBe(0);
    await close();
  });

  it("refuses a card URL with a query string without writing the route", async () => {
    const { impl, calls } = routeFetch(OK);
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect();
    const { isError, text } = await callText(client, TOOL_UPDATE_PROFILE, {
      ...BASE,
      agent_card_url: "https://acme.example/card.json?v=2",
    });

    expect(isError).toBe(true);
    expect(text).toMatch(/no query string/);
    expect(routeWrites(calls)).toBe(0);
    await close();
  });

  it("still requires contact and route, which the optional fields did not change", async () => {
    const { impl, calls } = routeFetch(OK);
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect();
    const { isError } = await callText(client, TOOL_UPDATE_PROFILE, {
      route_protocol_binding: "JSONRPC",
    });

    expect(isError).toBe(true);
    expect(routeWrites(calls)).toBe(0);
    await close();
  });

  it("advertises both fields as optional and names the three bindings", async () => {
    // The schema a client reads is the contract. Checking the served shape
    // rather than the source catches a required list that drifted.
    const { impl } = routeFetch(OK);
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect();
    const { tools } = await client.listTools();
    const schema = tools.find((t) => t.name === TOOL_UPDATE_PROFILE)?.inputSchema as
      | { required?: string[]; properties?: Record<string, { enum?: string[] }> }
      | undefined;

    expect(schema?.required?.slice().sort()).toEqual([
      "contact_email",
      "contact_name",
      "deal_route",
    ]);
    expect(schema?.properties?.route_protocol_binding?.enum).toEqual([
      "JSONRPC",
      "HTTP+JSON",
      "https://cogdepot.com/bindings/webhook-v1",
    ]);
    expect(schema?.properties?.agent_card_url).toBeDefined();
    await close();
  });
});
