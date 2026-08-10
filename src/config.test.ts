import { afterEach, describe, expect, it } from "vitest";

import {
  InvalidApiBaseUrlError,
  getApiBaseUrl,
  getDiscoveryUrl,
  resetApiBaseUrlForTesting,
  resolveApiBaseUrl,
  setApiBaseUrl,
} from "./config.js";
import { DEFAULT_API_BASE_URL } from "./strings.js";

afterEach(() => {
  resetApiBaseUrlForTesting();
});

describe("resolveApiBaseUrl", () => {
  it("defaults to production when unset or blank", () => {
    expect(resolveApiBaseUrl(undefined)).toBe(DEFAULT_API_BASE_URL);
    expect(resolveApiBaseUrl("")).toBe(DEFAULT_API_BASE_URL);
    expect(resolveApiBaseUrl("   ")).toBe(DEFAULT_API_BASE_URL);
  });

  it("accepts a cogdepot.com subdomain", () => {
    expect(resolveApiBaseUrl("https://staging.api.cogdepot.com")).toBe(
      "https://staging.api.cogdepot.com",
    );
  });

  it("accepts the apex", () => {
    expect(resolveApiBaseUrl("https://cogdepot.com")).toBe("https://cogdepot.com");
  });

  it("strips a trailing slash so paths do not double up", () => {
    expect(resolveApiBaseUrl("https://staging.api.cogdepot.com/")).toBe(
      "https://staging.api.cogdepot.com",
    );
  });

  it("refuses a host outside cogdepot.com, because the key travels with it", () => {
    expect(() => resolveApiBaseUrl("https://evil.example.com")).toThrow(InvalidApiBaseUrlError);
  });

  it("refuses a lookalike that merely ends in the domain", () => {
    // `endsWith("cogdepot.com")` alone would accept this. The dot boundary is
    // the whole point of the check.
    expect(() => resolveApiBaseUrl("https://evilcogdepot.com")).toThrow(InvalidApiBaseUrlError);
    expect(() => resolveApiBaseUrl("https://notcogdepot.com/api")).toThrow(InvalidApiBaseUrlError);
  });

  it("refuses plain http, since an API key must not travel in clear text", () => {
    expect(() => resolveApiBaseUrl("http://staging.api.cogdepot.com")).toThrow(
      InvalidApiBaseUrlError,
    );
  });

  it("refuses a value that is not a URL at all", () => {
    expect(() => resolveApiBaseUrl("staging.api.cogdepot.com")).toThrow(InvalidApiBaseUrlError);
    expect(() => resolveApiBaseUrl("not a url")).toThrow(InvalidApiBaseUrlError);
  });

  it("throws rather than falling back, so a wrong value cannot hit production", () => {
    // The failure mode this guards: someone sets the variable intending to test
    // against staging, it is rejected, and a silent fallback spends real credits.
    let message = "";
    try {
      resolveApiBaseUrl("https://example.com");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/will not send it elsewhere/);
  });
});

describe("the resolved base url", () => {
  it("is production until something sets it", () => {
    expect(getApiBaseUrl()).toBe(DEFAULT_API_BASE_URL);
    expect(getDiscoveryUrl()).toBe(`${DEFAULT_API_BASE_URL}/.well-known/cogdepot.json`);
  });

  it("carries the override through to the discovery document", () => {
    setApiBaseUrl(resolveApiBaseUrl("https://staging.api.cogdepot.com"));
    expect(getDiscoveryUrl()).toBe("https://staging.api.cogdepot.com/.well-known/cogdepot.json");
  });
});
