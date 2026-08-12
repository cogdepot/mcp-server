/**
 * Runtime configuration.
 *
 * The API base URL is overridable so the same package can be pointed at a
 * non-production deployment. Until this existed there was no way to exercise the
 * keyed tools without spending real credits against production, which is why
 * they had never been run against a funded account, a real thread or a real
 * deal.
 *
 * The override is deliberately constrained. This process holds a cogDepot API
 * key and attaches it to every request, so an unconstrained base URL is an
 * exfiltration path: one environment variable and the key goes to whoever set
 * it. Only https, and only hosts under cogdepot.com, are accepted.
 *
 * A rejected value is fatal rather than ignored. Silently falling back to
 * production would be worse than refusing: somebody who set this intending to
 * test would spend real credits believing they were on staging.
 */

import { DEFAULT_API_BASE_URL } from "./strings.js";

/** The only domain this package will send an API key to. */
export const ALLOWED_API_DOMAIN = "cogdepot.com";

/**
 * True when a hostname is cogdepot.com or a subdomain of it.
 *
 * Suffix match on a dot boundary. A bare `endsWith("cogdepot.com")` would also
 * accept `evilcogdepot.com`, which is the whole trick this guards.
 *
 * Shared rather than inlined because the keyless preview tool needs the same
 * answer: it follows a URL out of the discovery document, and a second copy of a
 * security predicate is one too many - the copy that drifts is the one that
 * stops guarding.
 */
export function isAllowedCogDepotHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === ALLOWED_API_DOMAIN || host.endsWith(`.${ALLOWED_API_DOMAIN}`);
}

export class InvalidApiBaseUrlError extends Error {
  override readonly name = "InvalidApiBaseUrlError";
}

let apiBaseUrl: string = DEFAULT_API_BASE_URL;

/**
 * Validates an override and returns the base URL to use.
 *
 * Returns the default when `raw` is unset or blank; throws when it is set to
 * something unusable, because a set-but-wrong value is a mistake worth stopping
 * for.
 */
export function resolveApiBaseUrl(raw: string | undefined): string {
  const candidate = raw?.trim();
  if (!candidate) return DEFAULT_API_BASE_URL;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new InvalidApiBaseUrlError(
      `COGDEPOT_API_BASE_URL is not a valid URL: ${candidate}`,
    );
  }

  if (parsed.protocol !== "https:") {
    throw new InvalidApiBaseUrlError(
      `COGDEPOT_API_BASE_URL must be https, got ${parsed.protocol}//. An API key must not travel in clear text.`,
    );
  }

  // Suffix match on a dot boundary. A bare `endsWith("cogdepot.com")` would
  // also accept `evilcogdepot.com`, which is the whole trick this guards.
  const host = parsed.hostname.toLowerCase();
  if (host !== ALLOWED_API_DOMAIN && !host.endsWith(`.${ALLOWED_API_DOMAIN}`)) {
    throw new InvalidApiBaseUrlError(
      `COGDEPOT_API_BASE_URL must be a ${ALLOWED_API_DOMAIN} host, got ${host}. ` +
        "This process attaches your API key to every request, so it will not send it elsewhere.",
    );
  }

  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** Applies a resolved base URL for the lifetime of the process. */
export function setApiBaseUrl(url: string): void {
  apiBaseUrl = url;
}

export function getApiBaseUrl(): string {
  return apiBaseUrl;
}

/** The discovery document, derived so an override reaches it too. */
export function getDiscoveryUrl(): string {
  return `${apiBaseUrl}/.well-known/cogdepot.json`;
}

/** Test seam. */
export function resetApiBaseUrlForTesting(): void {
  apiBaseUrl = DEFAULT_API_BASE_URL;
}
