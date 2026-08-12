import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { apiKeyFromRequest, buildServerForRequest, createRemoteHandler } from "./remote.js";
import { resetFactsCacheForTesting } from "./facts.js";
import { resetApiBaseUrlForTesting } from "./config.js";
import { REMOTE_API_KEY_HEADER, TOOL_GET_ACCOUNT, TOOL_DISCOVER } from "./strings.js";

/**
 * The remote entrypoint.
 *
 * The one behaviour that is new here, and the whole point of Phase 1, is that
 * the key is read per request rather than per process - so the same server
 * process serves a keyless caller and a keyed caller correctly. The tests drive
 * the per-request server the same way the rest of the suite drives the stdio one:
 * over an in-memory client, no socket required. Deployment glue (the Node server,
 * the Lambda adapter) is out of scope for the unit tests by design.
 */

const DISCOVERY = {
  apiBaseUrl: "https://api.cogdepot.com",
  credits: { dealFee: "2000 credits ($1.00) per side" },
};

/** Connects an in-memory client to whatever server the request maps to. */
async function toolsFor(request: Request | undefined): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "remote-test", version: "0.0.0" });
  await Promise.all([
    buildServerForRequest(request).connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name);
}

beforeEach(() => {
  resetFactsCacheForTesting();
  resetApiBaseUrlForTesting();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(DISCOVERY), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("reading the key from a request", () => {
  it("accepts an Authorization: Bearer key, the static-header connector form", () => {
    const request = new Request("https://mcp.cogdepot.com/", {
      headers: { authorization: "Bearer sk-abc123" },
    });
    expect(apiKeyFromRequest(request)).toBe("sk-abc123");
  });

  it("accepts a bare x-cogdepot-api-key header", () => {
    const request = new Request("https://mcp.cogdepot.com/", {
      headers: { [REMOTE_API_KEY_HEADER]: "sk-direct" },
    });
    expect(apiKeyFromRequest(request)).toBe("sk-direct");
  });

  it("returns undefined when no key is present, rather than an empty string", () => {
    const request = new Request("https://mcp.cogdepot.com/");
    expect(apiKeyFromRequest(request)).toBeUndefined();
  });

  it("treats a blank bearer as no key", () => {
    const request = new Request("https://mcp.cogdepot.com/", {
      headers: { authorization: "Bearer   " },
    });
    expect(apiKeyFromRequest(request)).toBeUndefined();
  });
});

describe("the tool set varies by the request's key", () => {
  it("serves only the keyless tools to a request with no key", async () => {
    const names = await toolsFor(new Request("https://mcp.cogdepot.com/"));
    expect(names).toContain(TOOL_DISCOVER);
    expect(names).not.toContain(TOOL_GET_ACCOUNT);
  });

  it("serves the keyed tools to a request carrying a key", async () => {
    const request = new Request("https://mcp.cogdepot.com/", {
      headers: { authorization: "Bearer a-real-looking-key" },
    });
    const names = await toolsFor(request);
    expect(names).toContain(TOOL_DISCOVER);
    expect(names).toContain(TOOL_GET_ACCOUNT);
  });

  it("keeps the zero-config promise: an undefined request is the keyless server", async () => {
    // The factory is handed ctx.requestInfo, which the SDK leaves undefined for
    // some construction paths. That must degrade to keyless, never throw.
    const names = await toolsFor(undefined);
    expect(names).toContain(TOOL_DISCOVER);
    expect(names).not.toContain(TOOL_GET_ACCOUNT);
  });
});

describe("the handler", () => {
  it("exposes a web-standard fetch entrypoint", () => {
    const handler = createRemoteHandler();
    expect(typeof handler.fetch).toBe("function");
  });

  it("refuses an off-domain base URL at startup, like stdio does", () => {
    // The deployment's base URL is validated when the handler is created, so a
    // misconfigured deploy fails fast instead of sending keys somewhere else.
    const previous = process.env["COGDEPOT_API_BASE_URL"];
    process.env["COGDEPOT_API_BASE_URL"] = "https://evil.example.com";
    try {
      expect(() => createRemoteHandler()).toThrow(/cogdepot\.com/i);
    } finally {
      if (previous === undefined) delete process.env["COGDEPOT_API_BASE_URL"];
      else process.env["COGDEPOT_API_BASE_URL"] = previous;
    }
  });
});
