/**
 * The remote HTTP entrypoint - the sibling to stdio.ts that core.ts decision L4
 * was written for. `buildServer` is reused untouched; only the transport and
 * where the credential comes from differ.
 *
 * It serves in one of two modes, chosen once at startup by whether the OAuth
 * environment is set:
 *
 * - Phase 1, static-header (OAuth unset): each request carries the caller's
 *   cogDepot API key in a header (Claude's `static_headers` auth type), and the
 *   server is built per request with that key - exactly as stdio builds it once
 *   per process from COGDEPOT_API_KEY. A request with no key gets the keyless
 *   server, so the zero-configuration discovery tools answer without auth.
 *
 * - OAuth (issuer/client/resource set): the Authorization bearer is a Cognito
 *   ACCESS token, verified here before anything runs. A GET to the
 *   protected-resource-metadata path returns the RFC 9728 document; a presented
 *   token that fails verification is answered 401 with a `WWW-Authenticate`
 *   challenge pointing there; a verified token is relayed to cogDepot as a
 *   bearer, which its own scope middleware re-verifies and maps to an account.
 *   A request with NO token still gets the keyless server, so the zero-config
 *   discovery promise holds in this mode too - only a bad token is refused, and
 *   the keyed tools simply require a good one.
 *
 * This is transport glue, not a deployment: adapting the returned handler to a
 * Lambda event or a Node server is a deploy concern (see scripts/serve-remote).
 */

import {
  createMcpHandler,
  type AuthInfo,
  type McpHandlerRequestOptions,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";

import { resolveApiBaseUrl, setApiBaseUrl } from "./config.js";
import { buildServer } from "./core.js";
import {
  createCognitoVerifier,
  protectedResourceMetadata,
  resolveOAuthConfig,
  type OAuthConfig,
} from "./oauth.js";
import { OAUTH_PROTECTED_RESOURCE_PATH, REMOTE_API_KEY_HEADER } from "./strings.js";

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
  return direct || undefined;
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
 * The base URL and the OAuth mode are both resolved once, here, from the
 * environment - they are properties of the deployment, not the request, the same
 * constraint stdio.ts enforces. An invalid base URL or a half-set OAuth config
 * throws out of this call rather than silently running against production or
 * accepting tokens nobody validated, so a misconfigured deploy fails at startup
 * instead of spending real credits or trusting the wrong issuer.
 *
 * The returned handler exposes a web-standard `fetch(request)`; a Node server or
 * a Lambda adapter drives it.
 */
export function createRemoteHandler(): McpHttpHandler {
  setApiBaseUrl(resolveApiBaseUrl(process.env["COGDEPOT_API_BASE_URL"]));

  const oauth = resolveOAuthConfig({
    issuer: process.env["COGDEPOT_OAUTH_ISSUER"],
    clientId: process.env["COGDEPOT_OAUTH_CLIENT_ID"],
    resource: process.env["COGDEPOT_OAUTH_RESOURCE"],
    scopes: parseScopeList(process.env["COGDEPOT_OAUTH_SCOPES"]),
  });

  if (!oauth) {
    // OAuth not configured: the Phase 1 static-header transport, unchanged.
    return createMcpHandler((ctx) => buildServerForRequest(ctx.requestInfo));
  }

  // OAuth configured: the credential comes only from the verified access token,
  // never from a request header, so the factory reads ctx.authInfo alone. A
  // request the gate lets through without a token carries no authInfo and builds
  // the keyless server.
  const inner = createMcpHandler((ctx) =>
    buildServer(ctx.authInfo ? { kind: "bearer", value: ctx.authInfo.token } : undefined),
  );
  return gateWithOAuth(inner, oauth, createCognitoVerifier(oauth));
}

/** The minimal verifier the gate needs; *createCognitoVerifier* satisfies it. */
interface AccessTokenVerifier {
  verifyAccessToken(token: string): Promise<AuthInfo>;
}

/**
 * Wraps an MCP handler with the OAuth request gate.
 *
 * The gate owns three things and defers everything else to the inner handler:
 *
 *  - a GET to the protected-resource-metadata path answers with the RFC 9728
 *    document, so a client can find the authorization server;
 *  - a request that presents NO bearer is passed straight through with no
 *    authInfo - the inner factory builds the keyless server, preserving the
 *    zero-configuration discovery promise in OAuth mode;
 *  - a request that DOES present a bearer must verify: a good token is relayed
 *    to the inner handler as authInfo, a bad one is refused 401 with a
 *    `WWW-Authenticate` challenge rather than falling through as if keyless.
 *
 * Exported so the gate is testable with a stub verifier and a fake inner handler,
 * offline - createRemoteHandler supplies the real Cognito verifier.
 */
export function gateWithOAuth(
  inner: McpHttpHandler,
  config: OAuthConfig,
  verifier: AccessTokenVerifier,
): McpHttpHandler {
  return {
    close: inner.close,
    notify: inner.notify,
    bus: inner.bus,
    fetch: async (request: Request, options?: McpHandlerRequestOptions): Promise<Response> => {
      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === OAUTH_PROTECTED_RESOURCE_PATH) {
        return jsonResponse(protectedResourceMetadata(config), 200);
      }

      const token = bearerFromAuthorization(request);
      if (!token) {
        // No token: the keyless server answers, exactly as an anonymous caller is
        // served over stdio and in Phase 1. Only a presented-but-bad token is a 401.
        return inner.fetch(request, options);
      }

      let authInfo: AuthInfo;
      try {
        authInfo = await verifier.verifyAccessToken(token);
      } catch (error) {
        return unauthorized(url, error);
      }
      return inner.fetch(request, { ...options, authInfo });
    },
  };
}

/**
 * The bearer token from an `Authorization: Bearer` header, or undefined.
 *
 * Distinct from apiKeyFromRequest, which also reads x-cogdepot-api-key and treats
 * the bearer as a raw key: in OAuth mode the bearer is an access token to verify,
 * and the x-api-key header is not an accepted credential, so the two paths do not
 * share this reader.
 */
function bearerFromAuthorization(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (!authorization) return undefined;
  const bearer = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return bearer?.[1]?.trim() || undefined;
}

/**
 * The 401 challenge for a token that failed verification.
 *
 * `resource_metadata` points at this deployment's own metadata path, derived from
 * the request origin rather than a Host header (the runner sets the origin to the
 * server it serves, so this is not a header-injection seam). The failure reason
 * is surfaced in error_description, sanitized so no quote or newline can break out
 * of the header value.
 */
function unauthorized(requestUrl: URL, error: unknown): Response {
  const metadataUrl = `${requestUrl.origin}${OAUTH_PROTECTED_RESOURCE_PATH}`;
  const detail = error instanceof Error ? error.message : "The access token could not be verified.";
  const safeDetail = detail.replace(/[\r\n"\\]/g, " ").trim();
  const challenge =
    `Bearer error="invalid_token", error_description="${safeDetail}", ` +
    `resource_metadata="${metadataUrl}"`;
  return new Response(JSON.stringify({ error: "invalid_token", error_description: safeDetail }), {
    status: 401,
    headers: { "content-type": "application/json", "WWW-Authenticate": challenge },
  });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Splits the scope environment variable into individual scopes.
 *
 * Space or comma separated, both tolerated because operators reach for either;
 * blank yields none, which resolveOAuthConfig accepts (scopes are advertised, not
 * required - cogDepot is the authority on which scope each action needs).
 */
function parseScopeList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
