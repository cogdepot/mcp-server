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

import { OAUTH_AUTHORIZE_PATH, OAUTH_TOKEN_PATH } from "./strings.js";

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
  issuer?: string | undefined;
  clientId?: string | undefined;
  resource?: string | undefined;
  scopes?: readonly string[] | undefined;
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
 * server. `authorization_servers` names THIS server's own resource URL rather
 * than the Cognito issuer directly, because the client next fetches that URL's
 * authorization-server metadata, and Cognito's own discovery omits the
 * `code_challenge_methods_supported` a spec-strict client checks before starting
 * PKCE. This server serves a corrected copy of that document (see
 * authorizationServerMetadata) at its own /.well-known path; Cognito still mints
 * and signs the tokens, only the discovery document is proxied.
 */
export function protectedResourceMetadata(config: OAuthConfig): Record<string, unknown> {
  return {
    resource: config.resource,
    authorization_servers: [config.resource],
    scopes_supported: [...config.scopes],
    bearer_methods_supported: ["header"],
  };
}

/**
 * The RFC 8414 authorization-server-metadata document this server serves on
 * Cognito's behalf.
 *
 * It is Cognito's own discovery document (`upstream`, fetched from the pool's
 * OpenID configuration) with the corrections a self-consistent, spec-strict
 * document needs:
 *
 *  - `issuer`, `authorization_endpoint` and `token_endpoint` are all re-homed to
 *    THIS server, so a client that expects the endpoints to share the issuer's
 *    origin is satisfied. The two endpoints resolve to `/oauth/authorize` and
 *    `/oauth/token` here, which proxy on to Cognito - so Cognito still runs the
 *    login and mints the tokens, but the client only ever talks to one origin;
 *  - `code_challenge_methods_supported` is added as `["S256"]` - the reason this
 *    proxy exists at all, since Cognito supports S256 PKCE but omits the field a
 *    client checks before starting;
 *  - `grant_types_supported` is stated explicitly rather than left to the client's
 *    default, and `scopes_supported` is set to the resource server's trading scopes
 *    rather than Cognito's default openid/email/phone/profile.
 *
 * jwks_uri and the signing-algorithm fields pass through as Cognito's, because the
 * tokens are still Cognito's and carry Cognito's `iss` - which is what the verifier
 * and cogDepot check. The re-homed issuer is only the discovery identity the client
 * talks to; it is never reconciled against the token.
 */
export function authorizationServerMetadata(
  config: OAuthConfig,
  upstream: Record<string, unknown>,
): Record<string, unknown> {
  const base = config.resource.replace(/\/+$/, "");
  return {
    ...upstream,
    issuer: config.resource,
    authorization_endpoint: `${base}${OAUTH_AUTHORIZE_PATH}`,
    token_endpoint: `${base}${OAUTH_TOKEN_PATH}`,
    scopes_supported: [...config.scopes],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
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
