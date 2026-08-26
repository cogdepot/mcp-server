/**
 * Asks a deployed MCP server what version it is.
 *
 * One copy, two callers: `drift.mjs` compares the answer to what npm serves, and
 * `assert-deployed-version.mjs` compares it to the tag being released. Both need
 * exactly this request, and a second inline copy is how the two would quietly
 * disagree about what "deployed" means.
 *
 * `initialize` is the whole conversation. It needs no key, creates no session
 * worth cleaning up, and `serverInfo.version` is the build the server is
 * actually running - not what a tag, a registry or a changelog claims.
 */

/** The MCP protocol revision to ask for. Any supported value works here. */
const PROTOCOL_VERSION = "2025-06-18";

/**
 * Returns the deployed `serverInfo.version`, or null if it cannot be read.
 *
 * Null means unknown, never stale: an unreachable host, a non-200, or a body
 * that does not parse all answer the same way, and every caller is expected to
 * treat that differently from a version that came back and disagreed.
 */
export async function deployedVersion(url, { timeoutMs = 15000 } = {}) {
  let response;
  try {
    response = await fetch(url, {
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
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "deployed-version", version: "0" },
        },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const body = await response.text();
  // Streamable HTTP answers as SSE, so the JSON sits behind a `data: ` prefix.
  // A plain JSON response is also legal, so handle both rather than assuming
  // the transport the deployment happens to use today.
  const payload = body.includes("data:") ? body.split("data:").pop().trim() : body.trim();

  try {
    return JSON.parse(payload)?.result?.serverInfo?.version ?? null;
  } catch {
    return null;
  }
}
