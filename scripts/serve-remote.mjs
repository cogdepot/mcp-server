/**
 * Runs the remote MCP handler on a local Node HTTP server.
 *
 * A convenience for developing and manually exercising remote.ts - not the
 * production deployment, which adapts the same handler to a Lambda event or
 * whatever the target is. That is why this lives in scripts/ rather than src/:
 * it is glue around the real entrypoint, and it reads PORT, which shipped code
 * deliberately does not.
 *
 *   COGDEPOT_API_BASE_URL=https://staging.api.cogdepot.com node scripts/serve-remote.mjs
 *
 * Then point an MCP client at http://localhost:8080/ and send the key as
 * `Authorization: Bearer <key>` or an `x-cogdepot-api-key` header. With no key,
 * the discovery tools still answer.
 */

import { createServer } from "node:http";
import { Readable } from "node:stream";

import { createRemoteHandler } from "../dist/remote.js";

const handler = createRemoteHandler();
const port = Number(process.env.PORT ?? 8080);

/** Node's IncomingMessage headers to a web Headers object. */
function toHeaders(nodeHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeHeaders)) {
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else if (value !== undefined) headers.set(name, value);
  }
  return headers;
}

/** Reads the request body into a Buffer, or undefined for bodyless methods. */
async function readBody(req) {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
}

const server = createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host ?? `localhost:${port}`}${req.url ?? "/"}`;
    const request = new Request(url, {
      method: req.method,
      headers: toHeaders(req.headers),
      body: await readBody(req),
    });

    const response = await handler.fetch(request);

    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) {
      // Pipe rather than buffer, so a streamed (SSE) response is not held whole.
      Readable.fromWeb(response.body).pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    // stderr, never stdout: nothing here shares the protocol channel, but the
    // habit is the codebase's, and a request failure should not be silent.
    process.stderr.write(`remote: request failed: ${error instanceof Error ? error.message : error}\n`);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(port, () => {
  process.stderr.write(`cogdepot-mcp remote listening on http://localhost:${port}\n`);
});
