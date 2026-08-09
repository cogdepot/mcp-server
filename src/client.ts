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
import { API_BASE_URL, REQUEST_TIMEOUT_MS } from "./strings.js";

export interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT";
  readonly body?: unknown;
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
  readonly #apiKey: string | undefined;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(apiKey?: string, baseUrl: string = API_BASE_URL, fetchImpl: typeof fetch = fetch) {
    this.#apiKey = apiKey?.trim() || undefined;
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#fetch = fetchImpl;
  }

  get hasKey(): boolean {
    return this.#apiKey !== undefined;
  }

  /**
   * Performs a request and returns the parsed body.
   *
   * `204 No Content` returns `undefined` - the profile writes answer that way,
   * and treating an empty body as a JSON parse failure would report success as
   * an error.
   */
  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T | undefined> {
    if (!this.#apiKey) throw new MissingApiKeyError();

    const method = options.method ?? "GET";
    const headers: Record<string, string> = {
      "x-api-key": this.#apiKey,
      accept: "application/json",
    };
    if (options.body !== undefined) headers["content-type"] = "application/json";

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
      // The top-up pointer comes from live facts so it cannot drift from what
      // the platform serves. Failing to read them must not mask the real error.
      let topUpUrl: string | undefined;
      try {
        const { facts } = await getFacts();
        topUpUrl = typeof facts.credits?.["topUp"] === "string"
          ? (facts.credits["topUp"] as string)
          : undefined;
      } catch {
        topUpUrl = undefined;
      }
      throw describeProblem(response.status, asProblem(raw), topUpUrl);
    }

    return raw as T;
  }
}
