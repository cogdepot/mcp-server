/**
 * The authenticated HTTP client.
 *
 * Thin on purpose: one place that attaches the key, enforces a timeout, and
 * converts a non-2xx into an already-rendered `ApiError`. Tools never see a
 * `Response` and never parse a problem document themselves, so the mapping
 * rules in errors.ts cannot be bypassed by a tool that forgets them.
 */

import { ApiError, asProblem, describeProblem } from "./errors.js";
import { getFacts } from "./facts.js";
import { getApiBaseUrl } from "./config.js";
import { REQUEST_TIMEOUT_MS, USER_AGENT } from "./strings.js";

/**
 * How the client authenticates to cogDepot.
 *
 * Two shapes because the remote transport carries two kinds of credential to the
 * same API. An `api-key` is the account's own key, sent as `x-api-key` exactly as
 * it always was - the stdio build and the Phase 1 static-header connector both
 * produce this. A `bearer` is a verified Cognito access token relayed straight
 * through as `Authorization: Bearer`: cogDepot's own scope middleware re-verifies
 * it and resolves the account, so the MCP server presents the user's token rather
 * than exchanging it for a key it does not hold.
 */
export type Credential =
  | { readonly kind: "api-key"; readonly value: string }
  | { readonly kind: "bearer"; readonly value: string };

export interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT";
  readonly body?: unknown;
  /**
   * Sent as `Idempotency-Key`. The API replays the original result for a
   * repeated key instead of executing the action again.
   *
   * Every endpoint that moves credits accepts one, and for those it is the
   * difference between a retried call and a second charge. Tools that spend
   * always send one.
   */
  readonly idempotencyKey?: string;
}

/**
 * A fresh idempotency key.
 *
 * Generated per tool call rather than per retry, which is the useful half: the
 * caller gets the key back in the response and can repeat the call with it if
 * the outcome was unclear. Without that, a model whose finalize timed out has
 * no safe move - calling again risks a second $1.00 charge and not calling
 * risks abandoning a sealed deal.
 */
export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

/**
 * Coerces the constructor's credential argument into a Credential or undefined.
 *
 * A bare string is an API key, preserving every existing caller. A blank value -
 * empty or whitespace-only, in either shape - is no credential rather than a
 * credential that is empty, so the keyless server answers instead of the API
 * rejecting a request that carries an empty header.
 */
function normalizeCredential(credential: string | Credential | undefined): Credential | undefined {
  if (credential === undefined) return undefined;
  if (typeof credential === "string") {
    const value = credential.trim();
    return value ? { kind: "api-key", value } : undefined;
  }
  const value = credential.value.trim();
  return value ? { kind: credential.kind, value } : undefined;
}

/** Thrown when a tool needing a key is invoked without one configured. */
export class MissingApiKeyError extends Error {
  override readonly name = "MissingApiKeyError";
  constructor() {
    super(
      "This tool needs a cogDepot API key. Set COGDEPOT_API_KEY in the MCP client configuration, " +
        "or call cogdepot_get_started for the three ways to obtain one - open registration is free " +
        "and needs no credentials.",
    );
  }
}

export class CogDepotClient {
  readonly #credential: Credential | undefined;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #userAgent: string;

  /**
   * A bare string first argument is an API key, so every existing
   * `new CogDepotClient(key)` caller is unchanged. A Credential selects the
   * header explicitly - the remote OAuth path passes a `bearer`.
   *
   * `userAgent` is a parameter rather than a module constant because the hosted
   * server must be separable from local installs in cogDepot's logs and runs
   * this same shared code. Passing it explicitly means a process announces what
   * its entrypoint says it is; there is no environment variable a local run
   * could set to claim it is the hosted deployment.
   */
  constructor(
    credential?: string | Credential,
    baseUrl: string = getApiBaseUrl(),
    fetchImpl: typeof fetch = fetch,
    userAgent: string = USER_AGENT,
  ) {
    this.#credential = normalizeCredential(credential);
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#fetch = fetchImpl;
    this.#userAgent = userAgent;
  }

  get hasKey(): boolean {
    return this.#credential !== undefined;
  }

  /**
   * Performs a request and returns the parsed body.
   *
   * `204 No Content` returns `undefined` - the profile writes answer that way,
   * and treating an empty body as a JSON parse failure would report success as
   * an error.
   */
  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T | undefined> {
    if (!this.#credential) throw new MissingApiKeyError();

    const method = options.method ?? "GET";
    // Node's fetch sends a default User-Agent of "node" only when none is set,
    // so setting ours here replaces it outright - nothing needs deleting. That
    // default was indistinguishable from cogDepot's own storefront SSR, which is
    // why no measurement run could attribute a tool call to this package.
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": this.#userAgent,
    };
    // The one place the two credential kinds diverge: an API key travels in
    // x-api-key, a relayed Cognito access token in Authorization: Bearer. Both
    // resolve to an account on the cogDepot side.
    if (this.#credential.kind === "bearer") {
      headers["authorization"] = `Bearer ${this.#credential.value}`;
    } else {
      headers["x-api-key"] = this.#credential.value;
    }
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (error) {
      // A transport failure is not a protocol error and must not be dressed up
      // as one - there is no problem document to read, and pretending otherwise
      // would produce a confident message about a status that never arrived.
      const cause = error instanceof Error ? error.message : String(error);
      throw new ApiError(0, "network_error", `Could not reach ${this.#baseUrl}: ${cause}`, true);
    }

    if (response.status === 204) return undefined;

    const raw: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const problem = asProblem(raw);
      // Fetch the top-up pointer only for the one reason that uses it. Doing it
      // on every failure put a network call on every error path, including a
      // cold-cache round trip inside the handling of a 401 - latency added to
      // failures, for a value the message would then discard.
      const needsTopUp = problem.reason === "insufficient_funds_self";
      throw describeProblem(response.status, problem, needsTopUp ? await topUpPointer() : undefined);
    }

    return raw as T;
  }
}

/**
 * The live top-up route, or undefined if the document does not state one.
 *
 * No try/catch here on purpose. `getFacts` is documented as never throwing - an
 * unreachable document degrades to the bundled snapshot - so wrapping this call
 * would add a branch no test can reach and no failure can enter. Defensive code
 * that cannot fire is not safety, it is a permanently untested path that makes
 * the coverage number mean less than it says.
 */
async function topUpPointer(): Promise<string | undefined> {
  const { facts } = await getFacts();
  const topUp = facts.credits?.["topUp"];
  return typeof topUp === "string" ? topUp : undefined;
}
