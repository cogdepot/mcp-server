import { describe, expect, it, beforeAll } from "vitest";
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
  type JWTVerifyGetKey,
} from "jose";

import {
  InvalidOAuthConfigError,
  createCognitoVerifier,
  protectedResourceMetadata,
  resolveOAuthConfig,
  type OAuthConfig,
} from "./oauth.js";

/**
 * The Phase 2 OAuth components, exercised fully offline.
 *
 * A generated RSA key pair stands in for Cognito's signing key: tokens are
 * signed here, served through a local JWKS, and verified - so every accept and
 * reject path is covered without a live authorization server. The claims mirror
 * a real Cognito access token, including the two that trip up a naive verifier:
 * there is no `aud`, and the binding is `client_id` + `token_use`.
 */

const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Example";
const CLIENT_ID = "the-mcp-app-client";
const KID = "test-key-1";

const CONFIG: OAuthConfig = {
  issuer: ISSUER,
  clientId: CLIENT_ID,
  resource: "https://mcp.cogdepot.com/",
  scopes: ["cogdepot/read", "cogdepot/trade:negotiate"],
};

let privateKey: CryptoKey;
let getKey: JWTVerifyGetKey;
/** A second key never placed in the JWKS, for the bad-signature case. */
let strangerKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  const publicJwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  getKey = createLocalJWKSet({ keys: [publicJwk] });

  const stranger = await generateKeyPair("RS256", { extractable: true });
  strangerKey = stranger.privateKey;
});

/** Signs an access-token-shaped JWT, letting each test override claims. */
async function accessToken(
  overrides: Record<string, unknown> = {},
  options: { key?: CryptoKey; issuer?: string; expired?: boolean } = {},
): Promise<string> {
  const jwt = new SignJWT({
    token_use: "access",
    client_id: CLIENT_ID,
    scope: "cogdepot/read cogdepot/trade:negotiate",
    username: "agent-007",
    ...overrides,
  })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setSubject("sub-abc")
    .setIssuedAt()
    .setIssuer(options.issuer ?? ISSUER)
    .setExpirationTime(options.expired ? "-1h" : "1h");
  return jwt.sign(options.key ?? privateKey);
}

describe("resolveOAuthConfig", () => {
  it("returns undefined when nothing is set, so OAuth stays opt-in", () => {
    expect(resolveOAuthConfig({})).toBeUndefined();
  });

  it("throws when only some fields are set - a half-configured authority", () => {
    expect(() => resolveOAuthConfig({ issuer: ISSUER })).toThrow(InvalidOAuthConfigError);
    expect(() => resolveOAuthConfig({ issuer: ISSUER, clientId: CLIENT_ID })).toThrow(
      InvalidOAuthConfigError,
    );
  });

  it("rejects a non-https issuer", () => {
    expect(() =>
      resolveOAuthConfig({ issuer: "http://example.com", clientId: CLIENT_ID, resource: "https://m/" }),
    ).toThrow(/https/i);
  });

  it("rejects an issuer that is not a URL at all", () => {
    expect(() =>
      resolveOAuthConfig({ issuer: "not a url", clientId: CLIENT_ID, resource: "https://m/" }),
    ).toThrow(/not a valid URL/i);
  });

  it("returns a config when all fields are valid", () => {
    const config = resolveOAuthConfig({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      resource: "https://mcp.cogdepot.com/",
      scopes: ["cogdepot/read"],
    });
    expect(config?.issuer).toBe(ISSUER);
    expect(config?.scopes).toEqual(["cogdepot/read"]);
  });
});

describe("protectedResourceMetadata", () => {
  it("names the authorization server and the advertised scopes", () => {
    const doc = protectedResourceMetadata(CONFIG);
    expect(doc["resource"]).toBe(CONFIG.resource);
    expect(doc["authorization_servers"]).toEqual([ISSUER]);
    expect(doc["scopes_supported"]).toEqual(CONFIG.scopes);
    expect(doc["bearer_methods_supported"]).toEqual(["header"]);
  });
});

describe("createCognitoVerifier", () => {
  it("accepts a valid access token and returns its scopes and expiry", async () => {
    const verifier = createCognitoVerifier(CONFIG, getKey);
    const info = await verifier.verifyAccessToken(await accessToken());

    expect(info.clientId).toBe(CLIENT_ID);
    expect(info.scopes).toEqual(["cogdepot/read", "cogdepot/trade:negotiate"]);
    // Always set from exp - the middleware rejects an AuthInfo with no expiry.
    expect(typeof info.expiresAt).toBe("number");
    expect(info.extra).toMatchObject({ sub: "sub-abc", username: "agent-007" });
  });

  it("rejects a token issued for a different client - the binding that stands in for aud", async () => {
    const verifier = createCognitoVerifier(CONFIG, getKey);
    await expect(
      verifier.verifyAccessToken(await accessToken({ client_id: "someone-elses-client" })),
    ).rejects.toThrow(/different client/i);
  });

  it("rejects an id token presented as an access token", async () => {
    const verifier = createCognitoVerifier(CONFIG, getKey);
    await expect(
      verifier.verifyAccessToken(await accessToken({ token_use: "id" })),
    ).rejects.toThrow(/access token/i);
  });

  it("rejects a token from a different issuer", async () => {
    const verifier = createCognitoVerifier(CONFIG, getKey);
    await expect(
      verifier.verifyAccessToken(await accessToken({}, { issuer: "https://evil.example.com/pool" })),
    ).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const verifier = createCognitoVerifier(CONFIG, getKey);
    await expect(
      verifier.verifyAccessToken(await accessToken({}, { expired: true })),
    ).rejects.toThrow();
  });

  it("rejects a token signed by a key not in the JWKS", async () => {
    const verifier = createCognitoVerifier(CONFIG, getKey);
    await expect(
      verifier.verifyAccessToken(await accessToken({}, { key: strangerKey })),
    ).rejects.toThrow();
  });

  it("treats a token with no scope claim as no scopes, not an error", async () => {
    const verifier = createCognitoVerifier(CONFIG, getKey);
    const info = await verifier.verifyAccessToken(await accessToken({ scope: undefined }));
    expect(info.scopes).toEqual([]);
  });

  it("omits absent optional claims from extra rather than carrying undefined", async () => {
    const verifier = createCognitoVerifier(CONFIG, getKey);
    // A token with a non-string username and no sub-derived extra: the optional
    // fields are dropped, not set to undefined.
    const info = await verifier.verifyAccessToken(
      await accessToken({ username: 42 }),
    );
    expect(info.extra).not.toHaveProperty("username");
    expect(info.extra).toMatchObject({ sub: "sub-abc" });
  });
});
