/**
 * End-to-end smoke test: spawns the built stdio server exactly as `npx` would,
 * speaks real MCP to it, and asserts the tools answer.
 *
 * This exists because unit tests mock the transport, and the failure this
 * catches - a broken bin entry, a bad import path in the emitted JS, a stray
 * write to stdout corrupting the protocol stream - only appears when the real
 * process is spawned.
 */

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const REQUIRED_TOOLS = ["cogdepot_discover", "cogdepot_get_started"];

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/stdio.js"],
  // Deliberately no COGDEPOT_API_KEY: the zero-configuration path is the
  // property under test.
  env: { PATH: process.env.PATH ?? "" },
});

const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
const names = tools.map((t) => t.name).sort();
console.log(`tools/list -> ${names.join(", ")}`);

for (const required of REQUIRED_TOOLS) {
  if (!names.includes(required)) fail(`tools/list is missing ${required}`);
}

for (const tool of tools) {
  if (!tool.title) fail(`${tool.name} has no title (required by directory review)`);
  const hints = tool.annotations ?? {};
  if (hints.readOnlyHint === undefined && hints.destructiveHint === undefined) {
    fail(`${tool.name} declares neither readOnlyHint nor destructiveHint`);
  }
}

for (const name of REQUIRED_TOOLS) {
  const result = await client.callTool({ name, arguments: {} });
  const text = (result.content ?? []).map((c) => c.text ?? "").join("");
  if (result.isError) fail(`${name} returned isError`);
  if (text.trim().length === 0) fail(`${name} returned empty content`);
  console.log(`${name} -> ${text.length} chars, first line: ${text.split("\n")[0]}`);

  // The point of live facts: a real price must appear, not a placeholder.
  if (name === "cogdepot_discover" && !/credit/i.test(text)) {
    fail("cogdepot_discover returned no credit pricing");
  }
}

await client.close();

if (process.exitCode) {
  console.error("smoke: FAILED");
} else {
  console.log("smoke: OK");
}
