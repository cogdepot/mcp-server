/**
 * Prompts, resources and completions - the three surfaces beyond tools.
 *
 * These are checked through a real client over a real transport rather than by
 * calling the registrars directly. A registrar that runs without throwing
 * proves nothing: the questions that matter are whether the surface is
 * advertised in `prompts/list` and `resources/list`, whether the keyed ones
 * respect the credential rule, and whether the money-safety properties this
 * package exists to protect survive the addition. None of that is observable
 * from inside the module.
 *
 * The load-bearing tests here are the negative ones. Resources are fetched by
 * hosts on their own initiative, so "no resource costs a credit" and "no
 * resource mutates" are not style preferences - they are the reason the set is
 * three documents instead of a listing template.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import { buildServer } from "./core.js";
import { resetFactsCacheForTesting } from "./facts.js";
import { resetPreviewCategories } from "./tools-listings.js";
import {
  PROMPT_CLOSE_OUT_A_DEAL,
  PROMPT_FIND_A_COUNTERPARTY,
  PROMPT_PLAN_MY_SPEND,
  PROMPT_SELL_A_CAPABILITY,
  PROMPT_TRIAGE_MY_THREADS,
  RESOURCE_ONBOARDING_URI,
  RESOURCE_OVERVIEW_URI,
  RESOURCE_PRICING_URI,
  TOOL_BROWSE_FEED,
  TOOL_FINALIZE_DEAL,
  TOOL_GET_LISTING,
} from "./strings.js";

const KEY = "test-key";

const DISCOVERY = {
  name: "cogDepot",
  tagline: "Anonymous broker for AI agents",
  apiBaseUrl: "https://api.cogdepot.com",
  credits: {
    meteredCall: "1 credit ($0.0005) per billable request",
    postingFee: "200 credits ($0.10) to post a listing",
    topUp: "POST /dashboard/credits",
  },
  registration: { open: "POST /v1/account/register" },
};

// Shaped as the storefront serves it. `fetchPreview` requires the `listings`
// wrapper and refuses a bare array, so that an HTML error page cannot degrade
// into a confident empty list reading as "nothing is trading".
const PREVIEW = {
  listings: [
    { id: "l1", title: "Translation", category: "translation", listing_type: "sell" },
    { id: "l2", title: "Research", category: "research", listing_type: "sell" },
    { id: "l3", title: "More translation", category: "translation", listing_type: "buy" },
  ],
};

/**
 * Routes a mocked fetch by path, and records every URL it was asked for.
 *
 * The recording is what lets the money-safety tests assert a negative: that
 * reading a resource never touched a metered route. Asserting on a call log is
 * the only way to prove an absence - checking the rendered text would pass just
 * as happily if the credit had been spent and the output happened not to
 * mention it.
 */
function routeFetch(routes: Record<string, { status: number; body?: unknown }>) {
  const seen: string[] = [];
  const impl = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    seen.push(url);
    const match = Object.keys(routes).find((path) => url.includes(path));
    const route = match ? routes[match] : undefined;
    if (!route) return new Response(JSON.stringify({ reason: "not_found" }), { status: 404 });
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status,
      headers: { "content-type": "application/json" },
    });
  });
  return { impl, seen };
}

const BASE_ROUTES = {
  "cogdepot.json": { status: 200, body: DISCOVERY },
  "/api/preview": { status: 200, body: PREVIEW },
};

async function connect(credential?: string) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = buildServer(credential);
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, close: () => client.close() };
}

/** Flattens a prompt's messages to text, which is all these prompts return. */
function promptText(result: { messages: Array<{ content: unknown }> }): string {
  return result.messages
    .map((m) => (m.content && typeof m.content === "object" && "text" in m.content ? String((m.content as { text: unknown }).text) : ""))
    .join("\n");
}

beforeEach(() => {
  resetFactsCacheForTesting();
  resetPreviewCategories();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prompts", () => {
  it("advertises the keyless planning prompt with no credential", async () => {
    vi.stubGlobal("fetch", routeFetch(BASE_ROUTES).impl);

    const { client, close } = await connect();
    const { prompts } = await client.listPrompts();

    expect(prompts.map((p) => p.name)).toContain(PROMPT_PLAN_MY_SPEND);
    await close();
  });

  it.each([
    PROMPT_SELL_A_CAPABILITY,
    PROMPT_FIND_A_COUNTERPARTY,
    PROMPT_TRIAGE_MY_THREADS,
    PROMPT_CLOSE_OUT_A_DEAL,
  ])("%s is withheld without a credential, on the same rule as the keyed tools", async (name) => {
    vi.stubGlobal("fetch", routeFetch(BASE_ROUTES).impl);

    const { client, close } = await connect();
    const { prompts } = await client.listPrompts();

    expect(prompts.map((p) => p.name)).not.toContain(name);
    await close();
  });

  it.each([
    PROMPT_SELL_A_CAPABILITY,
    PROMPT_FIND_A_COUNTERPARTY,
    PROMPT_TRIAGE_MY_THREADS,
    PROMPT_CLOSE_OUT_A_DEAL,
  ])("%s appears once a credential is configured", async (name) => {
    vi.stubGlobal("fetch", routeFetch(BASE_ROUTES).impl);

    const { client, close } = await connect(KEY);
    const { prompts } = await client.listPrompts();

    expect(prompts.map((p) => p.name)).toContain(name);
    await close();
  });

  it("every prompt carries a title and a description, which both directories require", async () => {
    vi.stubGlobal("fetch", routeFetch(BASE_ROUTES).impl);

    const { client, close } = await connect(KEY);
    const { prompts } = await client.listPrompts();

    for (const prompt of prompts) {
      expect(prompt.description, `${prompt.name} has no description`).toBeTruthy();
      expect(prompt.title ?? prompt.name, `${prompt.name} has no title`).toBeTruthy();
    }
    await close();
  });

  it("renders a prompt without calling the API at all", async () => {
    // A prompt that fetched on render would make opening a client's prompt menu
    // a network event, and for a metered route, a spend. They return text.
    const { impl, seen } = routeFetch(BASE_ROUTES);
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect(KEY);
    seen.length = 0;

    const result = await client.getPrompt({
      name: PROMPT_TRIAGE_MY_THREADS,
      arguments: {},
    });

    expect(promptText(result)).toContain("free");
    expect(seen).toEqual([]);
    await close();
  });

  it("states the posting fee before the step that incurs it", async () => {
    vi.stubGlobal("fetch", routeFetch(BASE_ROUTES).impl);

    const { client, close } = await connect(KEY);
    const result = await client.getPrompt({
      name: PROMPT_SELL_A_CAPABILITY,
      arguments: { offer: "I can translate technical documents" },
    });

    const text = promptText(result);
    expect(text).toContain("201 credits");
    // The draft-then-approve step is the guard. Without it the workflow reads as
    // "post this", and the model has permission to spend on the first turn.
    expect(text).toMatch(/do not post it yet/i);
    await close();
  });

  it("makes the irreversible step conditional on explicit approval", async () => {
    vi.stubGlobal("fetch", routeFetch(BASE_ROUTES).impl);

    const { client, close } = await connect(KEY);
    const result = await client.getPrompt({
      name: PROMPT_CLOSE_OUT_A_DEAL,
      arguments: { thread_id: "th_1" },
    });

    const text = promptText(result);
    expect(text).toContain("2,000 credits");
    expect(text).toMatch(/cannot be undone/i);
    expect(text).toMatch(/anonymity/i);
    expect(text).toMatch(/explicit approval|explicit yes/i);
    await close();
  });

  it("tells the triage workflow to stay off the metered tools", async () => {
    // Triage is reachable entirely through free calls. Saying so is what stops a
    // model reaching for browse_feed to answer a question about its own threads.
    vi.stubGlobal("fetch", routeFetch(BASE_ROUTES).impl);

    const { client, close } = await connect(KEY);
    const text = promptText(
      await client.getPrompt({ name: PROMPT_TRIAGE_MY_THREADS, arguments: {} }),
    );

    expect(text).toContain(TOOL_BROWSE_FEED);
    expect(text).toMatch(new RegExp(`do not call ${TOOL_BROWSE_FEED}`, "i"));
    expect(text).toMatch(new RegExp(`do not call ${TOOL_FINALIZE_DEAL}`, "i"));
    await close();
  });
});

describe("resources", () => {
  it("advertises all three documents with no credential", async () => {
    vi.stubGlobal("fetch", routeFetch(BASE_ROUTES).impl);

    const { client, close } = await connect();
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);

    expect(uris).toContain(RESOURCE_OVERVIEW_URI);
    expect(uris).toContain(RESOURCE_ONBOARDING_URI);
    expect(uris).toContain(RESOURCE_PRICING_URI);
    await close();
  });

  it.each([RESOURCE_OVERVIEW_URI, RESOURCE_ONBOARDING_URI, RESOURCE_PRICING_URI])(
    "%s reads without touching a metered route",
    async (uri) => {
      // The whole admission criterion for this set, asserted on the call log
      // rather than on the output. A host may fetch a resource whenever it
      // likes; if one of these reached /v1/feed or /v1/listings/{id}, a context
      // refresh would spend the user's credits.
      const { impl, seen } = routeFetch(BASE_ROUTES);
      vi.stubGlobal("fetch", impl);

      const { client, close } = await connect(KEY);
      seen.length = 0;

      const result = await client.readResource({ uri });

      expect(result.contents[0]?.text).toBeTruthy();
      expect(seen.filter((u) => u.includes("/v1/feed"))).toEqual([]);
      expect(seen.filter((u) => u.includes("/v1/listings/"))).toEqual([]);
      // /v1/account settles lapsed escrow holds on read, so it is a mutation and
      // is excluded for a different reason than cost.
      expect(seen.filter((u) => u.includes("/v1/account"))).toEqual([]);
      await close();
    },
  );

  it("does not expose a listing resource template, however tempting", async () => {
    vi.stubGlobal("fetch", routeFetch(BASE_ROUTES).impl);

    const { client, close } = await connect(KEY);
    const { resourceTemplates } = await client.listResourceTemplates();

    // cogdepot://listing/{id} is the obvious next resource and is deliberately
    // absent: reading a listing costs a credit, and a host refreshing context
    // would be spending money the user did not authorise per call.
    expect(resourceTemplates ?? []).toEqual([]);
    await close();
  });

  it("serves pricing that names both the free and the charged actions", async () => {
    vi.stubGlobal("fetch", routeFetch(BASE_ROUTES).impl);

    const { client, close } = await connect();
    const result = await client.readResource({ uri: RESOURCE_PRICING_URI });
    const text = String(result.contents[0]?.text ?? "");

    expect(text).toContain("1 credit ($0.0005)");
    expect(text).toMatch(/what is free/i);
    expect(text).toMatch(/what is not/i);
    await close();
  });

  it("labels a snapshot answer rather than passing it off as live", async () => {
    // getFacts falls back to the bundled snapshot when the document is
    // unreachable. A resource is pinned into a conversation's context, so an
    // unlabelled stale price is worse here than in a tool result a model reads
    // once.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );

    const { client, close } = await connect();
    const result = await client.readResource({ uri: RESOURCE_PRICING_URI });

    expect(String(result.contents[0]?.text ?? "")).toMatch(/NOTE:/);
    await close();
  });

  it("declares markdown, so a client renders it instead of showing source", async () => {
    vi.stubGlobal("fetch", routeFetch(BASE_ROUTES).impl);

    const { client, close } = await connect();
    const { resources } = await client.listResources();

    for (const resource of resources) {
      expect(resource.mimeType, `${resource.uri} has no mimeType`).toBe("text/markdown");
    }
    await close();
  });
});

describe("completions", () => {
  it("completes a category from the free preview, not from the metered feed", async () => {
    const { impl, seen } = routeFetch(BASE_ROUTES);
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect(KEY);
    seen.length = 0;

    const result = await client.complete({
      ref: { type: "ref/prompt", name: PROMPT_FIND_A_COUNTERPARTY },
      argument: { name: "category", value: "trans" },
    });

    expect(result.completion.values).toEqual(["translation"]);
    // The assertion that matters: autocomplete fires on keystrokes, so a
    // completion wired to browse_feed would charge a credit per character.
    expect(seen.filter((u) => u.includes("/v1/feed"))).toEqual([]);
    expect(seen.some((u) => u.includes("/api/preview"))).toBe(true);
    await close();
  });

  it("offers every category before anything is typed", async () => {
    vi.stubGlobal("fetch", routeFetch(BASE_ROUTES).impl);

    const { client, close } = await connect(KEY);
    const result = await client.complete({
      ref: { type: "ref/prompt", name: PROMPT_FIND_A_COUNTERPARTY },
      argument: { name: "category", value: "" },
    });

    expect(result.completion.values).toEqual(["research", "translation"]);
    await close();
  });

  it("caches, so typing does not issue one request per keystroke", async () => {
    // The storefront rate limits the preview per IP. An uncached completion
    // would trip that 429 and take the tool that shares the endpoint with it.
    const { impl, seen } = routeFetch(BASE_ROUTES);
    vi.stubGlobal("fetch", impl);

    const { client, close } = await connect(KEY);
    seen.length = 0;

    for (const value of ["t", "tr", "tra", "tran"]) {
      await client.complete({
        ref: { type: "ref/prompt", name: PROMPT_FIND_A_COUNTERPARTY },
        argument: { name: "category", value },
      });
    }

    expect(seen.filter((u) => u.includes("/api/preview"))).toHaveLength(1);
    await close();
  });

  it("returns nothing rather than an error when the preview is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("cogdepot.json")) {
          return new Response(JSON.stringify(DISCOVERY), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("down", { status: 503 });
      }),
    );

    const { client, close } = await connect(KEY);
    const result = await client.complete({
      ref: { type: "ref/prompt", name: PROMPT_FIND_A_COUNTERPARTY },
      argument: { name: "category", value: "tr" },
    });

    expect(result.completion.values).toEqual([]);
    await close();
  });
});

describe("workflow bodies, and the pricing gap", () => {
  it("renders the keyless planning prompt without a credential", async () => {
    vi.stubGlobal("fetch", routeFetch(BASE_ROUTES).impl);

    const { client, close } = await connect();
    const text = promptText(
      await client.getPrompt({ name: PROMPT_PLAN_MY_SPEND, arguments: {} }),
    );

    // It has to name the metered tools to explain their cost, while forbidding
    // calling them - the one prompt whose whole job is to spend nothing.
    expect(text).toContain(TOOL_BROWSE_FEED);
    expect(text).toContain(TOOL_GET_LISTING);
    expect(text).toMatch(/do not call any tool that costs credits/i);
    await close();
  });

  it("carries the supplied price and category into the selling workflow", async () => {
    vi.stubGlobal("fetch", routeFetch(BASE_ROUTES).impl);

    const { client, close } = await connect(KEY);
    const text = promptText(
      await client.getPrompt({
        name: PROMPT_SELL_A_CAPABILITY,
        arguments: { offer: "Translation", asking_price_usd: "25", category: "translation" },
      }),
    );

    expect(text).toContain("$25");
    expect(text).toContain("translation");
    // With a price given there is nothing to research, so the pricing step drops
    // out rather than sending the model to fetch comparables it was not asked for.
    expect(text).not.toMatch(/suggest a price/i);
    await close();
  });

  it("names the hold and the poster-only rule in the buying workflow", async () => {
    vi.stubGlobal("fetch", routeFetch(BASE_ROUTES).impl);

    const { client, close } = await connect(KEY);
    const text = promptText(
      await client.getPrompt({
        name: PROMPT_FIND_A_COUNTERPARTY,
        arguments: { need: "a translator", category: "translation", listing_type: "sell" },
      }),
    );

    expect(text).toContain("2,000-credit");
    expect(text).toMatch(/HOLD - not a spend/);
    // A negotiator that does not know this waits forever for the other side to
    // accept an offer only the poster can accept.
    expect(text).toMatch(/only the listing's poster can seal/i);
    await close();
  });

  it("says so plainly when the live document states no pricing at all", async () => {
    // The dangerous failure is a pricing resource that renders an empty section
    // and reads as "everything is free". It has to name the gap instead.
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "cogdepot.json": { status: 200, body: { name: "cogDepot", apiBaseUrl: "https://api.cogdepot.com" } },
      }).impl,
    );

    const { client, close } = await connect();
    const text = String(
      (await client.readResource({ uri: RESOURCE_PRICING_URI })).contents[0]?.text ?? "",
    );

    expect(text).toMatch(/states no pricing block/i);
    expect(text).not.toMatch(/free of charge|everything is free/i);
    await close();
  });
});

describe("what is deliberately not implemented", () => {
  it("ships no logging capability, which SEP-2577 deprecated", async () => {
    // Roots, sampling and logging were all deprecated in the 2026-07-28 spec.
    // The SEP's guidance is that new implementations should not adopt them, and
    // names stderr (stdio) and OpenTelemetry as the replacements. This server
    // logs to stderr; stdout is reserved for the protocol stream.
    vi.stubGlobal("fetch", routeFetch(BASE_ROUTES).impl);

    const { client, close } = await connect(KEY);
    const capabilities = client.getServerCapabilities();

    expect(capabilities?.logging).toBeUndefined();
    await close();
  });

  it("advertises the three current surfaces it does implement", async () => {
    vi.stubGlobal("fetch", routeFetch(BASE_ROUTES).impl);

    const { client, close } = await connect(KEY);
    const capabilities = client.getServerCapabilities();

    expect(capabilities?.tools).toBeDefined();
    expect(capabilities?.prompts).toBeDefined();
    expect(capabilities?.resources).toBeDefined();
    await close();
  });
});
