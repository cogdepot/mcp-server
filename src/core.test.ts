import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { buildServer } from "./core.js";
import { resetFactsCacheForTesting } from "./facts.js";
import { TOOL_DISCOVER, TOOL_GET_STARTED } from "./strings.js";

/**
 * Connects a real client to a real server over an in-memory pair. This is the
 * cheap counterpart to scripts/smoke.mjs: same protocol, no child process.
 */
async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = buildServer();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: () => client.close() };
}

beforeEach(() => {
  resetFactsCacheForTesting();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        name: "cogDepot",
        apiBaseUrl: "https://api.cogdepot.com",
        credits: { dealFee: "2000 credits ($1.00) per side" },
        registration: { method: "POST /v1/account/register" },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tool surface", () => {
  it("exposes exactly the free tools while the paid ones are gated", async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([TOOL_DISCOVER, TOOL_GET_STARTED]);
    await close();
  });

  it("gives every tool a title and an explicit read-only hint", async () => {
    // Both connector directories name missing titles and missing annotations as
    // a common rejection cause, and the hints drive Claude's auto-permissions,
    // so an unannotated tool is a review failure and a safety gap at once.
    const { client, close } = await connect();
    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.title, `${tool.name} needs a title`).toBeTruthy();
      expect(tool.annotations?.readOnlyHint, `${tool.name} must declare readOnlyHint`).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
    }
    await close();
  });

  it("describes cost in the description, since that is all a model sees", async () => {
    const { client, close } = await connect();
    const { tools } = await client.listTools();

    for (const tool of tools) {
      expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
      expect(tool.description).toMatch(/no api key|spends no credits/i);
    }
    await close();
  });

  it("answers cogdepot_discover with live pricing and no error flag", async () => {
    const { client, close } = await connect();

    const result = await client.callTool({ name: TOOL_DISCOVER, arguments: {} });
    const text = (result.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");

    expect(result.isError).toBeFalsy();
    expect(text).toContain("2000 credits ($1.00) per side");
    await close();
  });

  it("answers cogdepot_get_started with the registration route", async () => {
    const { client, close } = await connect();

    const result = await client.callTool({ name: TOOL_GET_STARTED, arguments: {} });
    const text = (result.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");

    expect(result.isError).toBeFalsy();
    expect(text).toContain("POST /v1/account/register");
    await close();
  });

  it("still answers when the live document is unreachable", async () => {
    // The zero-configuration promise has to hold offline too: a first-time user
    // behind a proxy must still learn what cogDepot is.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const { client, close } = await connect();

    const result = await client.callTool({ name: TOOL_DISCOVER, arguments: {} });
    const text = (result.content ?? []).map((c) => ("text" in c ? c.text : "")).join("");

    expect(result.isError).toBeFalsy();
    expect(text).toMatch(/cogDepot/);
    await close();
  });
});
