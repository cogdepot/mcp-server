import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { GetParameterCommand } from "@aws-sdk/client-ssm";

import { CogDepotClient } from "./client.js";
import { resetApiBaseUrlForTesting, setApiBaseUrl } from "./config.js";
import { buildServer } from "./core.js";
import { getFacts, resetFactsCacheForTesting } from "./facts.js";
import {
  hasStageKey,
  InvalidStageKeyConfigError,
  normalizeStageKey,
  resetStageKeyForTesting,
  setStageKey,
  stageKeyHeaders,
} from "./stage-key.js";
import { loadStageKeyFromSsm, StageKeyLoadError, stageKeyLoader } from "./stage-key-ssm.js";
import {
  STAGE_KEY_HEADER,
  STAGE_KEY_PLACEHOLDER,
  TOOL_GET_REPUTATION,
  TOOL_GET_STATS,
  TOOL_PREVIEW_LISTINGS,
} from "./strings.js";

/**
 * The stage key.
 *
 * A gated non-production deployment refuses every request without its key, the
 * keyless ones included, so the contract is coverage: every call site that
 * leaves the process sends it when one is configured, and none sends it to
 * production or outside cogdepot.com.
 */

const STAGING_API = "https://staging.api.cogdepot.com";
const KEY = "stage-key-for-tests";

const STAGING_DISCOVERY = {
  apiBaseUrl: STAGING_API,
  credits: { meteredCall: "1 credit ($0.0005) per billable request" },
  keylessPreview: { url: "https://stg.cogdepot.com/api/preview" },
};

const REPUTATION_RECORD = {
  handle: "a3f19c02b7e4",
  seller: { rating_sum: 5, rating_count: 1, finalized_count: 0, non_delivery_count: 0, warm_start: true },
  buyer: { rating_sum: 5, rating_count: 1, finalized_count: 0, non_delivery_count: 0, warm_start: true },
  funded: false,
  domain_verified: false,
  as_of: "2026-08-21T12:00:00Z",
};

/** Records every outbound call's stage-key header and answers the routes given. */
function recordingFetch(routes: Record<string, unknown> = {}) {
  const calls: { url: string; stageKey: string | null; apiKey: string | null }[] = [];
  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers((init?.headers ?? {}) as HeadersInit);
    calls.push({ url, stageKey: headers.get(STAGE_KEY_HEADER), apiKey: headers.get("x-api-key") });
    const match = Object.keys(routes).find((path) => url.includes(path));
    return new Response(JSON.stringify(match ? routes[match] : {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { impl, calls };
}

function keyFor(calls: { url: string; stageKey: string | null }[], fragment: string) {
  const call = calls.find((entry) => entry.url.includes(fragment));
  expect(call, `no call to ${fragment}`).toBeDefined();
  return call?.stageKey;
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([buildServer().connect(serverTransport), client.connect(clientTransport)]);
  await client.callTool({ name, arguments: args });
  await client.close();
}

function fakeReader(value: string | undefined) {
  const send = vi.fn(async (_command: GetParameterCommand) => ({
    Parameter: value === undefined ? {} : { Value: value },
  }));
  return { send };
}

beforeEach(() => {
  resetFactsCacheForTesting();
  resetStageKeyForTesting();
  resetApiBaseUrlForTesting();
});

afterEach(() => {
  resetStageKeyForTesting();
  resetApiBaseUrlForTesting();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("normalizeStageKey reads a value the way the gate does", () => {
  it("drops trailing newlines and nothing else", () => {
    expect(normalizeStageKey(`${KEY}\n`)).toBe(KEY);
    expect(normalizeStageKey(`${KEY}\n\n`)).toBe(KEY);
    expect(normalizeStageKey(` ${KEY} `)).toBe(` ${KEY} `);
  });

  it("treats unset, empty and the placeholder as no key", () => {
    expect(normalizeStageKey(undefined)).toBeUndefined();
    expect(normalizeStageKey("")).toBeUndefined();
    expect(normalizeStageKey("\n")).toBeUndefined();
    expect(normalizeStageKey(STAGE_KEY_PLACEHOLDER)).toBeUndefined();
    expect(normalizeStageKey(`${STAGE_KEY_PLACEHOLDER}\n`)).toBeUndefined();
  });
});

describe("setStageKey", () => {
  it("refuses a stage key aimed at production", () => {
    expect(() => setStageKey(KEY)).toThrow(InvalidStageKeyConfigError);
    expect(hasStageKey()).toBe(false);
  });

  it("accepts one for a non-production base URL", () => {
    setApiBaseUrl(STAGING_API);
    setStageKey(KEY);
    expect(hasStageKey()).toBe(true);
  });

  it("lets production run with no key or the placeholder, exactly as before", () => {
    expect(() => setStageKey(undefined)).not.toThrow();
    expect(() => setStageKey("")).not.toThrow();
    expect(() => setStageKey(STAGE_KEY_PLACEHOLDER)).not.toThrow();
    expect(hasStageKey()).toBe(false);
  });

  it("clears a key when given none", () => {
    setApiBaseUrl(STAGING_API);
    setStageKey(KEY);
    setStageKey(STAGE_KEY_PLACEHOLDER);
    expect(hasStageKey()).toBe(false);
  });
});

describe("stageKeyHeaders decides where the key may go", () => {
  beforeEach(() => {
    setApiBaseUrl(STAGING_API);
    setStageKey(KEY);
  });

  it("sends it to the staging API and the staging storefront", () => {
    expect(stageKeyHeaders(`${STAGING_API}/v1/board`)).toEqual({ [STAGE_KEY_HEADER]: KEY });
    expect(stageKeyHeaders("https://stg.cogdepot.com/api/preview")).toEqual({ [STAGE_KEY_HEADER]: KEY });
  });

  it("never sends it to production's hosts", () => {
    expect(stageKeyHeaders("https://api.cogdepot.com/v1/board")).toEqual({});
    expect(stageKeyHeaders("https://cogdepot.com/api/preview")).toEqual({});
    expect(stageKeyHeaders("https://www.cogdepot.com/api/preview")).toEqual({});
    expect(stageKeyHeaders("https://API.cogdepot.com/v1/board")).toEqual({});
  });

  it("never sends it outside cogdepot.com", () => {
    expect(stageKeyHeaders("https://evilcogdepot.com/api/preview")).toEqual({});
    expect(stageKeyHeaders("https://cogdepot.com.example/api/preview")).toEqual({});
  });

  it("sends nothing for a target that does not parse", () => {
    expect(stageKeyHeaders("not a url")).toEqual({});
  });

  it("sends nothing when no key is configured", () => {
    resetStageKeyForTesting();
    expect(stageKeyHeaders(`${STAGING_API}/v1/board`)).toEqual({});
  });
});

describe("every outbound call carries the key", () => {
  beforeEach(() => {
    setApiBaseUrl(STAGING_API);
    setStageKey(KEY);
  });

  it("the authenticated client, beside the account's own credential", async () => {
    const { impl, calls } = recordingFetch();
    const client = new CogDepotClient("account-key", STAGING_API, impl);

    await client.request("/v1/account");

    expect(calls[0]?.stageKey).toBe(KEY);
    expect(calls[0]?.apiKey).toBe("account-key");
  });

  it("the discovery fetch", async () => {
    const { impl, calls } = recordingFetch({ "/.well-known/cogdepot.json": STAGING_DISCOVERY });
    vi.stubGlobal("fetch", impl);

    expect((await getFacts()).provenance).toBe("live");
    expect(keyFor(calls, "/.well-known/cogdepot.json")).toBe(KEY);
  });

  it("the storefront listing preview", async () => {
    const { impl, calls } = recordingFetch({
      "/.well-known/cogdepot.json": STAGING_DISCOVERY,
      "/api/preview": { listings: [] },
    });
    vi.stubGlobal("fetch", impl);

    await callTool(TOOL_PREVIEW_LISTINGS);

    expect(keyFor(calls, "stg.cogdepot.com/api/preview")).toBe(KEY);
  });

  it("the public reputation lookup", async () => {
    const { impl, calls } = recordingFetch({
      "/.well-known/cogdepot.json": STAGING_DISCOVERY,
      "/v1/reputation/": REPUTATION_RECORD,
    });
    vi.stubGlobal("fetch", impl);

    await callTool(TOOL_GET_REPUTATION, { handle: "a3f19c02b7e4" });

    expect(keyFor(calls, "/v1/reputation/")).toBe(KEY);
  });

  it("the public statistics", async () => {
    const { impl, calls } = recordingFetch({ "/.well-known/cogdepot.json": STAGING_DISCOVERY });
    vi.stubGlobal("fetch", impl);

    await callTool(TOOL_GET_STATS);

    expect(keyFor(calls, "/stats.json")).toBe(KEY);
  });
});

describe("with no key configured nothing changes", () => {
  it("sends no stage-key header on any call", async () => {
    setApiBaseUrl(STAGING_API);
    const { impl, calls } = recordingFetch({
      "/.well-known/cogdepot.json": STAGING_DISCOVERY,
      "/api/preview": { listings: [] },
      "/v1/reputation/": REPUTATION_RECORD,
    });
    vi.stubGlobal("fetch", impl);

    await callTool(TOOL_PREVIEW_LISTINGS);
    await callTool(TOOL_GET_REPUTATION, { handle: "a3f19c02b7e4" });
    await callTool(TOOL_GET_STATS);
    await new CogDepotClient("account-key", STAGING_API, impl).request("/v1/account");

    expect(calls.length).toBeGreaterThan(3);
    expect(calls.every((call) => call.stageKey === null)).toBe(true);
  });
});

describe("loadStageKeyFromSsm", () => {
  beforeEach(() => {
    setApiBaseUrl(STAGING_API);
  });

  it("reads the named parameter with decryption and applies it", async () => {
    const reader = fakeReader(`${KEY}\n`);

    await loadStageKeyFromSsm("/cogdepot/staging/STAGE_KEY", reader);

    const command = reader.send.mock.calls[0]?.[0];
    expect(command?.input).toEqual({ Name: "/cogdepot/staging/STAGE_KEY", WithDecryption: true });
    expect(stageKeyHeaders(`${STAGING_API}/v1/board`)).toEqual({ [STAGE_KEY_HEADER]: KEY });
  });

  it("leaves no key when the parameter still holds the placeholder", async () => {
    await loadStageKeyFromSsm("/p", fakeReader(STAGE_KEY_PLACEHOLDER));
    expect(hasStageKey()).toBe(false);
  });

  it("fails with the parameter's name, never a value, when the read is denied", async () => {
    const reader = {
      send: vi.fn(async () => {
        throw Object.assign(new Error("not authorized to perform ssm:GetParameter"), {
          name: "AccessDeniedException",
        });
      }),
    };

    const failure = loadStageKeyFromSsm("/cogdepot/staging/STAGE_KEY", reader);

    await expect(failure).rejects.toBeInstanceOf(StageKeyLoadError);
    await expect(failure).rejects.toThrow(/\/cogdepot\/staging\/STAGE_KEY.*AccessDeniedException/);
  });

  it("fails when the parameter has no value", async () => {
    await expect(loadStageKeyFromSsm("/p", fakeReader(undefined))).rejects.toBeInstanceOf(
      StageKeyLoadError,
    );
  });
});

describe("stageKeyLoader", () => {
  it("does nothing when no parameter is named, which is production", async () => {
    const load = vi.fn(async () => {});

    await stageKeyLoader(undefined, load)();
    await stageKeyLoader("  ", load)();

    expect(load).not.toHaveBeenCalled();
  });

  it("loads once and remembers a success", async () => {
    const load = vi.fn(async () => {});
    const ensure = stageKeyLoader("/p", load);

    await ensure();
    await ensure();

    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("/p");
  });

  it("retries a failure on the next call instead of remembering it", async () => {
    const load = vi
      .fn<(name: string) => Promise<void>>()
      .mockRejectedValueOnce(new StageKeyLoadError("denied"))
      .mockResolvedValueOnce(undefined);
    const ensure = stageKeyLoader("/p", load);

    await expect(ensure()).rejects.toThrow("denied");
    await expect(ensure()).resolves.toBeUndefined();
    await ensure();

    expect(load).toHaveBeenCalledTimes(2);
  });
});
