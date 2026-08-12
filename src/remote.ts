/**
 * The remote HTTP entrypoint - the sibling to stdio.ts that core.ts decision L4
 * was written for. `buildServer` is reused untouched; only the transport and
 * where the key comes from differ.
 *
 * This is Phase 1: a static-header connector. Each request carries the caller's
 * cogDepot API key in a header (Claude's `static_headers` auth type), and the
 * server is built per request with that key - exactly as stdio builds it once
 * per process from COGDEPOT_API_KEY. A request with no key gets the keyless
 * server, so the zero-configuration discovery tools answer without auth, the
 * same promise the stdio build makes.
 *
 * Two things this file deliberately is NOT yet, marked so no one mistakes the
 * scaffold for the finished thing:
 *
 * - It is not per-user OAuth. A static header is one shared credential, not a
 *   user identity. Phase 2 replaces the header read with bearer verification
 *   against Cognito, adds a protected-resource-metadata route, and returns a 401
 *   challenge for keyed tools. The `apiKeyFromRequest` seam is where that lands.
 * - It is not a deployment. The handler is transport glue; adapting it to a
 *   Lambda event or a Node server is a deploy concern (see scripts/serve-remote).
 */

import { createMcpHandler } from "@modelcontextprotocol/server";

import { resolveApiBaseUrl, setApiBaseUrl } from "./config.js";
import { buildServer } from "./core.js";
import { REMOTE_API_KEY_HEADER } from "./strings.js";

/**
 * Extracts the cogDepot API key from a request.
 *
 * Two accepted forms: `Authorization: Bearer <key>`, which is what a
 * static-header connector sends, and a bare `x-cogdepot-api-key` header for
 * direct calls and tests. Absent or blank yields undefined, which builds the
 * keyless server rather than raising - the discovery tools must answer without a
 * key, exactly as they do over stdio.
 *
 * This is the seam Phase 2 changes: there the Authorization bearer is an OAuth
 * access token to verify against Cognito, not a raw key to forward.
 */
export function apiKeyFromRequest(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    const token = bearer?.[1]?.trim();
    if (token) return token;
  }
  const direct = request.headers.get(REMOTE_API_KEY_HEADER)?.trim();
  return direct ? direct : undefined;
}

/**
 * Builds the per-request server. This is the entire per-request auth model in
 * Phase 1: the key present on the request decides the tool set, exactly as the
 * environment variable decides it for stdio. No key means the keyless server,
 * not an error.
 */
export function buildServerForRequest(request: Request | undefined) {
  return buildServer(request ? apiKeyFromRequest(request) : undefined);
}

/**
 * Creates the HTTP handler.
 *
 * The base URL is resolved once, here, from the environment - it is a property
 * of the deployment, not the request, the same constraint stdio.ts enforces. An
 * invalid override throws out of this call rather than silently running against
 * production, so a misconfigured deploy fails at startup instead of spending
 * real credits.
 *
 * The returned handler exposes a web-standard `fetch(request)`; a Node server or
 * a Lambda adapter drives it.
 */
export function createRemoteHandler() {
  setApiBaseUrl(resolveApiBaseUrl(process.env["COGDEPOT_API_BASE_URL"]));
  return createMcpHandler((ctx) => buildServerForRequest(ctx.requestInfo));
}
