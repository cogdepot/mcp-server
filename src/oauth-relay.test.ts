import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { buildServer } from "./core.js";
import { resetFactsCacheForTesting } from "./facts.js";
import { resetApiBaseUrlForTesting } from "./config.js";
import { TOOL_GET_ACCOUNT } from "./strings.js";

/**
 * The end of the relay, asserted on the wire.
 *
 * The gate (remote.test.ts) proves a verified token becomes an authInfo, and
 * core.test.ts proves an authInfo builds the keyed tool set. This closes the
 * last link: that calling a keyed tool built from a bearer credential actually
 * puts that token on the outbound request to cogDepot as `Authorization: Bearer`
 * - never as x-api-key - so cogDepot's RequireScope sees the token it must
 * re-verify. Driven over the in-memory MCP transport with a mocked fetch, so the
 * whole path from tool call to outbound header is exercised without a socket.
 */
describe("the OAuth relay puts the verified token on the wire to cogDepot", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetFactsCacheForTesting();
    resetApiBaseUrlForTesting();
    fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ balance_micro: 0, held_micro: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("relays a bearer credential to /v1/account as Authorization: Bearer, not x-api-key", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer({ kind: "bearer", value: "relayed-access-token" });
    const client = new Client({ name: "relay-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await client.callTool({ name: TOOL_GET_ACCOUNT, arguments: {} });
    await client.close();

    const call = fetchSpy.mock.calls.find(([url]) => String(url).endsWith("/v1/account"));
    expect(call, "the account tool must have called GET /v1/account").toBeTruthy();
    const headers = (call![1] as RequestInit).headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer relayed-access-token");
    expect(headers["x-api-key"]).toBeUndefined();
  });

  it("still sends an api-key credential as x-api-key, so the relay change did not disturb the key path", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer("an-api-key");
    const client = new Client({ name: "relay-test", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await client.callTool({ name: TOOL_GET_ACCOUNT, arguments: {} });
    await client.close();

    const call = fetchSpy.mock.calls.find(([url]) => String(url).endsWith("/v1/account"));
    expect(call, "the account tool must have called GET /v1/account").toBeTruthy();
    const headers = (call![1] as RequestInit).headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("an-api-key");
    expect(headers["authorization"]).toBeUndefined();
  });
});
