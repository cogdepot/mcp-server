import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { CogDepotClient } from "./client.js";
import { buildServer } from "./core.js";
import { buildServerForRequest } from "./remote.js";
import { resetFactsCacheForTesting } from "./facts.js";
import { getFacts } from "./facts.js";
import {
  REMOTE_USER_AGENT,
  SERVER_VERSION,
  TOOL_GET_REPUTATION,
  TOOL_PREVIEW_LISTINGS,
  USER_AGENT,
} from "./strings.js";

/**
 * Outbound request identification.
 *
 * Until 0.7.1 every request this package made carried Node's default `node`,
 * which is the same string cogDepot's own storefront SSR sends. Three
 * measurement runs in a row could not attribute a single tool call, so these
 * assertions are the contract that made the attribution possible rather than a
 * restatement of the implementation: what matters is that the header is present
 * on every call site that leaves the process, that the hosted deployment is
 * separable from local installs, and that CI bursts are separable from both.
 */

/** The exact shape the main repo's traffic tooling classifies on. */
const UA_PATTERN = /^cogdepot-mcp(-remote)?\/\d+\.\d+\.\d+( \(ci\))?$/;

// Exact-value assertions below compare against the exported USER_AGENT and
// REMOTE_USER_AGENT rather than rebuilding the string from SERVER_VERSION. A
// rebuilt literal omits the " (ci)" suffix, so it passes on a developer's
// machine and fails in Actions, where CI is set - which is exactly how this
// suite first went red. The constants are what is under test anyway; the format
// itself is pinned by UA_PATTERN and by the CI-marker cases at the bottom.

const DISCOVERY = {
  apiBaseUrl: "https://api.cogdepot.com",
  credits: { meteredCall: "1 credit ($0.0005) per billable request" },
  keylessPreview: { url: "https://cogdepot.com/api/preview" },
};

const REPUTATION_RECORD = {
  handle: "a3f19c02b7e4",
  seller: { rating_sum: 5, rating_count: 1, finalized_count: 0, non_delivery_count: 0, warm_start: true },
  buyer: { rating_sum: 5, rating_count: 1, finalized_count: 0, non_delivery_count: 0, warm_start: true },
  funded: false,
  domain_verified: false,
  as_of: "2026-08-21T12:00:00Z",
};

/**
 * Records the headers of every outbound call and answers the handful of routes
 * the tools under test reach. Header capture is the whole point, so it reads
 * both a plain object and a Headers instance rather than assuming either.
 */
function recordingFetch(routes: Record<string, unknown> = {}) {
  const calls: { url: string; userAgent: string | undefined }[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const raw = init?.headers;
    const headers = new Headers((raw ?? {}) as HeadersInit);
    calls.push({ url, userAgent: headers.get("user-agent") ?? undefined });
    const match = Object.keys(routes).find((path) => url.includes(path));
    return new Response(JSON.stringify(match ? routes[match] : {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { impl, calls };
}

function uaFor(calls: { url: string; userAgent: string | undefined }[], fragment: string) {
  return calls.find((call) => call.url.includes(fragment))?.userAgent;
}

async function connect(server: ReturnType<typeof buildServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => client.close() };
}

beforeEach(() => {
  resetFactsCacheForTesting();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the authenticated client identifies itself", () => {
  it("sends a versioned user-agent on a GET", async () => {
    const { impl, calls } = recordingFetch();
    const client = new CogDepotClient("key", "https://api.cogdepot.com", impl);

    await client.request("/v1/account");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.userAgent).toMatch(UA_PATTERN);
    expect(calls[0]?.userAgent).toBe(USER_AGENT);
  });

  it("sends a versioned user-agent on a POST", async () => {
    const { impl, calls } = recordingFetch();
    const client = new CogDepotClient("key", "https://api.cogdepot.com", impl);

    await client.request("/v1/listings", { method: "POST", body: { title: "probe" } });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.userAgent).toMatch(UA_PATTERN);
  });

  it("keeps the user-agent alongside the credential headers rather than replacing them", async () => {
    // A regression guard with a real cause: the header block is also where the
    // key travels, and an edit that rebuilt the object could silently drop it.
    const { impl } = recordingFetch();
    const seen: Record<string, string>[] = [];
    const capture = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(Object.fromEntries(new Headers((init?.headers ?? {}) as HeadersInit)));
      return impl(input, init);
    });
    const client = new CogDepotClient("secret-key", "https://api.cogdepot.com", capture);

    await client.request("/v1/account");

    expect(seen[0]?.["x-api-key"]).toBe("secret-key");
    expect(seen[0]?.["user-agent"]).toMatch(UA_PATTERN);
    expect(seen[0]?.["accept"]).toBe("application/json");
  });

  it("sends the remote user-agent when the hosted entrypoint configures one", async () => {
    const { impl, calls } = recordingFetch();
    const client = new CogDepotClient("key", "https://api.cogdepot.com", impl, REMOTE_USER_AGENT);

    await client.request("/v1/account");

    expect(calls[0]?.userAgent).toMatch(UA_PATTERN);
    expect(calls[0]?.userAgent).toBe(REMOTE_USER_AGENT);
  });
});

describe("the keyless calls identify themselves", () => {
  it("sends a versioned user-agent on the discovery fetch", async () => {
    const { impl, calls } = recordingFetch({ "/.well-known/cogdepot.json": DISCOVERY });
    vi.stubGlobal("fetch", impl);

    const result = await getFacts();

    expect(result.provenance).toBe("live");
    expect(uaFor(calls, "/.well-known/cogdepot.json")).toMatch(UA_PATTERN);
  });

  it("sends a versioned user-agent on the storefront listing preview", async () => {
    // This is the call that collided with cogDepot's own SSR: same host, same
    // default user-agent, no way to tell a tool call from a page render.
    const { impl, calls } = recordingFetch({
      "/.well-known/cogdepot.json": DISCOVERY,
      "/api/preview": { listings: [] },
    });
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect(buildServer());
    await client.callTool({ name: TOOL_PREVIEW_LISTINGS, arguments: {} });
    await close();

    expect(uaFor(calls, "/api/preview")).toMatch(UA_PATTERN);
  });

  it("sends a versioned user-agent on the public reputation lookup", async () => {
    const { impl, calls } = recordingFetch({
      "/.well-known/cogdepot.json": DISCOVERY,
      "/v1/reputation/": REPUTATION_RECORD,
    });
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect(buildServer());
    await client.callTool({ name: TOOL_GET_REPUTATION, arguments: { handle: "a3f19c02b7e4" } });
    await close();

    expect(uaFor(calls, "/v1/reputation/")).toMatch(UA_PATTERN);
  });
});

describe("the hosted server never borrows the caller's identity", () => {
  it("sends its own user-agent outbound, not the inbound client's", async () => {
    // lambda.ts copies every inbound header into the Request it hands the
    // handler, user-agent included. That header must stay inbound: if it were
    // forwarded, cogDepot's logs would attribute hosted traffic to whichever
    // MCP client happened to call, which is the measurement this release fixes.
    const { impl, calls } = recordingFetch({
      "/.well-known/cogdepot.json": DISCOVERY,
      "/v1/reputation/": REPUTATION_RECORD,
    });
    vi.stubGlobal("fetch", impl);

    const inbound = new Request("https://mcp.cogdepot.com/", {
      headers: { "user-agent": "SomeMcpClient/9.9.9" },
    });
    const { client, close } = await connect(buildServerForRequest(inbound));
    await client.callTool({ name: TOOL_GET_REPUTATION, arguments: { handle: "a3f19c02b7e4" } });
    await close();

    const sent = uaFor(calls, "/v1/reputation/");
    expect(sent).toBe(REMOTE_USER_AGENT);
    expect(sent).not.toContain("SomeMcpClient");
    for (const call of calls) {
      expect(call.userAgent).not.toContain("SomeMcpClient");
    }
  });
});

describe("the CI marker", () => {
  // USER_AGENT is computed once at module load, so the environment has to be
  // stubbed before the module is imported - resetModules is what makes the
  // second import re-evaluate rather than return the first module instance.
  it('appends " (ci)" when CI is set', async () => {
    vi.resetModules();
    vi.stubEnv("CI", "true");

    const strings = await import("./strings.js");

    expect(strings.USER_AGENT).toBe(`cogdepot-mcp/${SERVER_VERSION} (ci)`);
    expect(strings.REMOTE_USER_AGENT).toBe(`cogdepot-mcp-remote/${SERVER_VERSION} (ci)`);
    expect(strings.USER_AGENT).toMatch(UA_PATTERN);
    expect(strings.REMOTE_USER_AGENT).toMatch(UA_PATTERN);
  });

  it("is absent when CI is not set", async () => {
    vi.resetModules();
    vi.stubEnv("CI", undefined);

    const strings = await import("./strings.js");

    expect(strings.USER_AGENT).toBe(`cogdepot-mcp/${SERVER_VERSION}`);
    expect(strings.REMOTE_USER_AGENT).toBe(`cogdepot-mcp-remote/${SERVER_VERSION}`);
    expect(strings.USER_AGENT).not.toContain("(ci)");
  });
});

describe("the user-agent strings themselves", () => {
  it("match the pattern the traffic tooling classifies on", () => {
    // Whatever CI state this suite runs under, both strings must be
    // classifiable - the tooling matches on this exact shape.
    expect(USER_AGENT).toMatch(UA_PATTERN);
    expect(REMOTE_USER_AGENT).toMatch(UA_PATTERN);
  });

  it("carries the advertised server version, so a log line names a release", () => {
    expect(USER_AGENT).toContain(SERVER_VERSION);
    expect(REMOTE_USER_AGENT).toContain(SERVER_VERSION);
  });

  it("keeps the hosted deployment distinguishable from a local install", () => {
    expect(USER_AGENT.startsWith("cogdepot-mcp/")).toBe(true);
    expect(REMOTE_USER_AGENT.startsWith("cogdepot-mcp-remote/")).toBe(true);
    expect(USER_AGENT).not.toBe(REMOTE_USER_AGENT);
  });
});
