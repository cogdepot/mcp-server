import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, type AuthInfo, type McpHttpHandler } from "@modelcontextprotocol/server";

import { apiKeyFromRequest, buildServerForRequest, createRemoteHandler, gateWithOAuth } from "./remote.js";
import { resetFactsCacheForTesting } from "./facts.js";
import { resetApiBaseUrlForTesting } from "./config.js";
import {
  OAUTH_PROTECTED_RESOURCE_PATH,
  REMOTE_API_KEY_HEADER,
  TOOL_GET_ACCOUNT,
  TOOL_DISCOVER,
} from "./strings.js";

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

  it("returns a plain McpHttpHandler when OAuth is unconfigured", () => {
    // With no OAuth env, createRemoteHandler is the Phase 1 handler - no gate, no
    // metadata route. A GET to the well-known path is not specially served (the
    // MCP handler answers it however it answers any unknown GET), which is the
    // observable shape of "OAuth is off".
    const handler = createRemoteHandler();
    expect(typeof handler.fetch).toBe("function");
  });

  it("answers a real MCP initialize over its fetch entrypoint", async () => {
    // Drives handler.fetch directly - no socket - so the actual HTTP request
    // path is covered, not only the in-memory factory. This is the in-process
    // counterpart to the manual curl check.
    const handler = createRemoteHandler();
    const response = await handler.fetch(
      new Request("http://localhost/", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "remote-test", version: "0" },
          },
        }),
      }),
    );

    expect(response.status).toBe(200);
    // The body may be SSE-framed (event: message / data: {...}); assert on the
    // serverInfo payload rather than the framing.
    const text = await response.text();
    expect(text).toContain("cogdepot");
    expect(text).toContain("2025-06-18");
  });
});

describe("the OAuth gate", () => {
  const OAUTH_CONFIG = {
    issuer: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Test",
    clientId: "agent-client-id",
    resource: "https://mcp.cogdepot.com",
    scopes: ["cogdepot/read", "cogdepot/trade:finalize"],
  } as const;

  /** A stand-in inner handler that records the authInfo each call is handed. */
  function fakeInner(): { handler: McpHttpHandler; seen: Array<AuthInfo | undefined> } {
    const seen: Array<AuthInfo | undefined> = [];
    const handler: McpHttpHandler = {
      fetch: async (_request, options) => {
        seen.push(options?.authInfo);
        return new Response("inner", { status: 200 });
      },
      close: async () => {},
      notify: {} as never,
      bus: {} as never,
    };
    return { handler, seen };
  }

  /** A verifier that either returns fixed claims (echoing the token) or throws. */
  function stubVerifier(result: AuthInfo | Error) {
    return {
      verifyAccessToken: async (token: string): Promise<AuthInfo> => {
        if (result instanceof Error) throw result;
        return { ...result, token };
      },
    };
  }

  const post = (headers?: Record<string, string>) =>
    new Request("https://mcp.cogdepot.com/", { method: "POST", ...(headers ? { headers } : {}) });

  it("serves the RFC 9728 metadata document at the well-known path, without touching the inner handler", async () => {
    const { handler, seen } = fakeInner();
    const gated = gateWithOAuth(handler, OAUTH_CONFIG, stubVerifier(new Error("unused")));

    const res = await gated.fetch(new Request(`https://mcp.cogdepot.com${OAUTH_PROTECTED_RESOURCE_PATH}`));

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["resource"]).toBe(OAUTH_CONFIG.resource);
    expect(body["authorization_servers"]).toEqual([OAUTH_CONFIG.issuer]);
    expect(body["scopes_supported"]).toEqual([...OAUTH_CONFIG.scopes]);
    expect(seen).toHaveLength(0);
  });

  it("passes a request with no bearer straight through as keyless", async () => {
    // The zero-config promise in OAuth mode: no token is not an error, it is an
    // anonymous caller, and the inner handler builds the keyless server (no authInfo).
    const { handler, seen } = fakeInner();
    const gated = gateWithOAuth(handler, OAUTH_CONFIG, stubVerifier(new Error("unused")));

    const res = await gated.fetch(post());

    expect(res.status).toBe(200);
    expect(seen).toEqual([undefined]);
  });

  it("refuses a presented-but-invalid token with a 401 challenge rather than a passthrough", async () => {
    const { handler, seen } = fakeInner();
    const gated = gateWithOAuth(handler, OAUTH_CONFIG, stubVerifier(new Error("token expired")));

    const res = await gated.fetch(post({ authorization: "Bearer bad-token" }));

    expect(res.status).toBe(401);
    const challenge = res.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(
      `resource_metadata="https://mcp.cogdepot.com${OAUTH_PROTECTED_RESOURCE_PATH}"`,
    );
    // Refused before the inner handler ran: a bad token never reaches the server.
    expect(seen).toHaveLength(0);
  });

  it("verifies a good token and relays it to the inner handler as authInfo", async () => {
    const { handler, seen } = fakeInner();
    const claims: AuthInfo = {
      token: "",
      clientId: OAUTH_CONFIG.clientId,
      scopes: ["cogdepot/read"],
      expiresAt: 9_999_999_999,
    };
    const gated = gateWithOAuth(handler, OAUTH_CONFIG, stubVerifier(claims));

    const res = await gated.fetch(post({ authorization: "Bearer good-token" }));

    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.token).toBe("good-token");
    expect(seen[0]?.scopes).toEqual(["cogdepot/read"]);
  });

  it("sanitizes the failure reason so it cannot break out of the header value", async () => {
    const { handler } = fakeInner();
    const gated = gateWithOAuth(handler, OAUTH_CONFIG, stubVerifier(new Error('bad "quote" and\nnewline')));

    const res = await gated.fetch(post({ authorization: "Bearer x" }));

    const challenge = res.headers.get("WWW-Authenticate") ?? "";
    expect(challenge).not.toContain('"quote"');
    expect(challenge).not.toContain("\n");
  });
});

describe("createRemoteHandler with OAuth configured", () => {
  const OAUTH_ENV = {
    COGDEPOT_OAUTH_ISSUER: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Test",
    COGDEPOT_OAUTH_CLIENT_ID: "agent-client-id",
    COGDEPOT_OAUTH_RESOURCE: "https://mcp.cogdepot.com",
    COGDEPOT_OAUTH_SCOPES: "cogdepot/read cogdepot/trade:finalize",
  } as const;

  function withEnv(vars: Record<string, string | undefined>, run: () => void | Promise<void>) {
    const previous = new Map<string, string | undefined>();
    for (const [k, v] of Object.entries(vars)) {
      previous.set(k, process.env[k]);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return run();
    } finally {
      for (const [k, v] of previous) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  it("builds a gated handler that serves the metadata route", async () => {
    await withEnv(OAUTH_ENV, async () => {
      const handler = createRemoteHandler();
      const res = await handler.fetch(
        new Request(`https://mcp.cogdepot.com${OAUTH_PROTECTED_RESOURCE_PATH}`),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body["authorization_servers"]).toEqual([OAUTH_ENV.COGDEPOT_OAUTH_ISSUER]);
    });
  });

  it("fails fast on a half-configured OAuth env rather than trusting no issuer", () => {
    withEnv(
      { ...OAUTH_ENV, COGDEPOT_OAUTH_CLIENT_ID: undefined },
      () => {
        expect(() => createRemoteHandler()).toThrow(/partially configured/i);
      },
    );
  });
});
