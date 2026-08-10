#!/usr/bin/env node
/**
 * The stdio entrypoint - what `npx @cogdepot/mcp-server` runs.
 *
 * Deliberately thin. Everything meaningful is in core.ts, so adding a remote
 * HTTP transport later is a sibling of this file rather than a rewrite.
 *
 * COGDEPOT_API_KEY is optional today: only the free, keyless tools ship, and
 * the server must be useful with zero configuration. It is read here so the
 * wiring is in place, and so a user who sets it gets no surprise later.
 */

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

import { resolveApiBaseUrl, setApiBaseUrl } from "./config.js";
import { buildServer } from "./core.js";

async function main(): Promise<void> {
  // Resolved before anything else so an invalid override stops the process
  // rather than silently running against production. Someone who sets this
  // intending to test would otherwise spend real credits believing they were
  // pointed somewhere safe.
  setApiBaseUrl(resolveApiBaseUrl(process.env["COGDEPOT_API_BASE_URL"]));

  const server = buildServer(process.env["COGDEPOT_API_KEY"]);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  // stdout is the protocol channel: anything written there that is not a
  // JSON-RPC message corrupts the stream and the client reports a parse error
  // rather than the actual fault. Diagnostics go to stderr, always.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`cogdepot-mcp failed to start: ${message}\n`);
  process.exit(1);
});
