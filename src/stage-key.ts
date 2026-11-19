/**
 * The stage key: what a non-production cogDepot deployment asks of every caller.
 *
 * A staging deployment can sit behind a gate that admits only requests carrying
 * the deployment's own key in `x-preview-key`. The staging API and the staging
 * storefront both check it, and without it the storefront answers 404 to
 * everything and the API refuses. So a server pointed at staging has to send it
 * on every outbound request, the keyless ones included: the preview, the
 * reputation lookup, the statistics and the discovery document are exactly the
 * calls that carry no other credential.
 *
 * It is a property of the deployment, not of the caller, so it is configured
 * once per process, the same as the base URL: COGDEPOT_STAGE_KEY for the stdio
 * server and a local remote server, an SSM parameter for the hosted one (see
 * stage-key-ssm.ts).
 *
 * Two guards keep it from going anywhere it should not:
 *
 * - It cannot be configured against production. A stage key with the default
 *   base URL is a configuration mistake, and it is fatal at startup rather than
 *   quietly sent to the production API.
 * - It is attached only to cogdepot.com hosts that are not production's. The
 *   preview URL is read out of the discovery document, so the target host is not
 *   always the base URL's.
 */

import { getApiBaseUrl, isAllowedCogDepotHost } from "./config.js";
import { DEFAULT_API_BASE_URL, SITE_URL, STAGE_KEY_HEADER, STAGE_KEY_PLACEHOLDER } from "./strings.js";

export class InvalidStageKeyConfigError extends Error {
  override readonly name = "InvalidStageKeyConfigError";
}

/**
 * Production's hosts. The stage key is never sent to any of them, whatever the
 * discovery document points at.
 */
const PRODUCTION_HOSTS: ReadonlySet<string> = new Set([
  new URL(DEFAULT_API_BASE_URL).hostname,
  new URL(SITE_URL).hostname,
  `www.${new URL(SITE_URL).hostname}`,
]);

let stageKey: string | undefined;

/**
 * Normalizes a raw stage key the way the cogDepot gate does: trailing newlines
 * are dropped (a parameter written from a file keeps one), and an empty value or
 * the placeholder a fresh parameter is created with means no key. Anything else
 * is kept byte for byte, because the gate compares it exactly.
 */
export function normalizeStageKey(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const value = raw.replace(/\n+$/, "");
  if (value === "" || value === STAGE_KEY_PLACEHOLDER) return undefined;
  return value;
}

/**
 * Applies a stage key for the lifetime of the process. Call it after the base
 * URL is set: the production check reads it.
 *
 * An unset, empty or placeholder value clears the key, so a deployment whose
 * parameter has not been filled in yet keeps working exactly as it did.
 */
export function setStageKey(raw: string | undefined): void {
  const value = normalizeStageKey(raw);
  if (value !== undefined && getApiBaseUrl() === DEFAULT_API_BASE_URL) {
    throw new InvalidStageKeyConfigError(
      "A stage key is set but COGDEPOT_API_BASE_URL is production. The stage key belongs to a " +
        "non-production deployment; point COGDEPOT_API_BASE_URL at it, or unset the key.",
    );
  }
  stageKey = value;
}

/** True when a stage key is configured. */
export function hasStageKey(): boolean {
  return stageKey !== undefined;
}

/**
 * The header to add to a request for `target`, or an empty object.
 *
 * Spread into a request's headers at every outbound call site, so a call that
 * needs no key costs one lookup and adds nothing. A target that does not parse
 * gets nothing: the caller's own fetch reports that URL's problem better than a
 * throw from here would.
 */
export function stageKeyHeaders(target: string): Record<string, string> {
  if (stageKey === undefined) return {};
  let host: string;
  try {
    host = new URL(target).hostname.toLowerCase();
  } catch {
    return {};
  }
  if (!isAllowedCogDepotHost(host) || PRODUCTION_HOSTS.has(host)) return {};
  return { [STAGE_KEY_HEADER]: stageKey };
}

/** Test seam. */
export function resetStageKeyForTesting(): void {
  stageKey = undefined;
}
