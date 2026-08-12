/**
 * Phase 2 groundwork: the Cognito side of remote auth.
 *
 * Two standalone, tested components - a protected-resource-metadata document and
 * a Cognito access-token verifier. They are deliberately NOT wired into the live
 * request path yet, for the same reason Phase 1 was honest about what it is not:
 * verifying a user's OAuth token only becomes useful once the cogDepot API
 * accepts that token (Phase 3, API-side). Until then a verified token has no key
 * to call the API with, so wiring a live OAuth mode would build a path that
 * authenticates and then cannot act. These pieces light up when Phase 3 lands.
 *
 * What the live probe pinned down, and why this module looks the way it does:
 *
 * - The authorization server is the Cognito user pool. Its access tokens are
 *   RS256 and carry `iss`, `client_id`, `token_use` and `scope` - but NO `aud`
 *   claim, and Cognito ignores the RFC 8707 `resource` parameter. So the binding
 *   is validated on `iss` + `client_id` + `token_use`, not on audience. A
 *   verifier that asserted `aud` would reject every real Cognito token.
 * - JWT and JWKS verification goes through `jose` rather than hand-rolled RS256.
 *   Auth code is where the worst bugs live; the standard library is the safer
 *   choice than a bespoke signature check.
 */

import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import { OAuthError, OAuthErrorCode, type AuthInfo } from "@modelcontextprotocol/server";

/**
 * Resolved, validated OAuth configuration. Absent (undefined) means OAuth is not
 * configured and the remote server stays on the Phase 1 static-header model.
 */
export interface OAuthConfig {
  /** The Cognito user pool issuer, e.g. https://cognito-idp.us-east-1.amazonaws.com/us-east-1_XXXX */
  readonly issuer: string;
  /** The app-client id a token's `client_id` claim must equal. */
  readonly clientId: string;
  /** The MCP server's resource identifier, published in the metadata document. */
  readonly resource: string;
  /** The resource-server scopes advertised as available, e.g. `cogdepot/read`. */
  readonly scopes: readonly string[];
}

/** Thrown when OAuth config is partially or invalidly set - a misconfiguration worth stopping for. */
export class InvalidOAuthConfigError extends Error {
  override readonly name = "InvalidOAuthConfigError";
}

/**
 * Validates OAuth configuration from raw values.
 *
 * Returns undefined when nothing is set - OAuth is opt-in, and its absence keeps
 * the static-header path. Throws when it is set-but-wrong, mirroring how
 * config.ts treats a bad base URL: a half-configured authorization server is a
 * mistake to fail on, not to paper over, because the failure mode is silently
 * accepting tokens nobody validated.
 */
export function resolveOAuthConfig(values: {
  issuer?: string;
  clientId?: string;
  resource?: string;
  scopes?: readonly string[];
}): OAuthConfig | undefined {
  const issuer = values.issuer?.trim();
  const clientId = values.clientId?.trim();
  const resource = values.resource?.trim();

  if (!issuer && !clientId && !resource) return undefined;

  if (!issuer || !clientId || !resource) {
    throw new InvalidOAuthConfigError(
      "OAuth is partially configured. Set all of the issuer, client id and resource, or none.",
    );
  }

  assertHttpsUrl(issuer, "issuer");
  assertHttpsUrl(resource, "resource");

  return {
    issuer,
    clientId,
    resource,
    scopes: values.scopes ?? [],
  };
}

/**
 * The RFC 9728 protected-resource-metadata document.
 *
 * This is what a `401` points a client at so it can discover the authorization
 * server. `authorization_servers` names the Cognito issuer; the client resolves
 * Cognito's own discovery from there.
 */
export function protectedResourceMetadata(config: OAuthConfig): Record<string, unknown> {
  return {
    resource: config.resource,
    authorization_servers: [config.issuer],
    scopes_supported: [...config.scopes],
    bearer_methods_supported: ["header"],
  };
}

/**
 * A token verifier for the SDK's bearer-auth middleware.
 *
 * `verifyAccessToken` returns an `AuthInfo` on success and throws an `OAuthError`
 * with `InvalidToken` on any failure - unknown key, bad signature, wrong issuer,
 * wrong client, wrong token_use, or expiry - which the middleware maps to a 401
 * challenge. `expiresAt` is always set from the token's `exp`, because the
 * middleware rejects an AuthInfo whose expiry is unset.
 */
export function createCognitoVerifier(
  config: OAuthConfig,
  // The key resolver is injectable so tests can supply a local JWKS built from a
  // generated key pair - the whole verifier is then exercised offline, no live
  // Cognito. Production omits it and gets the remote JWKS, which caches keys and
  // refetches on an unknown kid, so it is built once per verifier not per request.
  getKey: JWTVerifyGetKey = createRemoteJWKSet(new URL(`${config.issuer}/.well-known/jwks.json`)),
): { verifyAccessToken(token: string): Promise<AuthInfo> } {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, getKey, {
          issuer: config.issuer,
          algorithms: ["RS256"],
        }));
      } catch (cause) {
        throw invalidToken(`token signature or issuer did not verify: ${describe(cause)}`);
      }

      // Cognito-specific claims, checked explicitly. token_use guards against an
      // ID token being presented where an access token is required; client_id is
      // the binding that stands in for the absent `aud`.
      if (payload["token_use"] !== "access") {
        throw invalidToken("not an access token (token_use is not 'access')");
      }
      if (payload["client_id"] !== config.clientId) {
        throw invalidToken("token was issued for a different client");
      }
      if (typeof payload.exp !== "number") {
        throw invalidToken("token has no expiry");
      }

      return {
        token,
        clientId: config.clientId,
        scopes: parseScopes(payload["scope"]),
        expiresAt: payload.exp,
        extra: {
          ...(typeof payload.sub === "string" ? { sub: payload.sub } : {}),
          ...(typeof payload["username"] === "string" ? { username: payload["username"] } : {}),
        },
      };
    },
  };
}

/** Cognito's `scope` is a space-delimited string; absent means no scopes. */
function parseScopes(scope: unknown): string[] {
  if (typeof scope !== "string") return [];
  return scope.split(/\s+/).filter((s) => s.length > 0);
}

function assertHttpsUrl(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new InvalidOAuthConfigError(`OAuth ${label} is not a valid URL: ${value}`);
  }
  if (parsed.protocol !== "https:") {
    throw new InvalidOAuthConfigError(`OAuth ${label} must be https, got ${parsed.protocol}//`);
  }
}

function invalidToken(detail: string): OAuthError {
  return new OAuthError(OAuthErrorCode.InvalidToken, detail);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
