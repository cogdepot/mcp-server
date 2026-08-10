/**
 * The transport-agnostic core.
 *
 * Every tool is registered here, against an `McpServer` that knows nothing
 * about how it is reached. `stdio.ts` hands this object to a stdio transport;
 * a future HTTP entrypoint wraps the same builder in `createMcpHandler`. That
 * is the whole reason the remote transport is a later addition rather than a
 * rewrite - see the plan's decision L4.
 */

import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { CogDepotClient } from "./client.js";
import { getFacts, type CogDepotFacts, type FactsResult } from "./facts.js";
import { registerAccountTools } from "./tools-account.js";
import { registerDealTools } from "./tools-deals.js";
import { registerMyListingsTool, registerPreviewTool } from "./tools-listings.js";
import {
  DESCRIPTION_DISCOVER,
  DESCRIPTION_GET_STARTED,
  SERVER_NAME,
  SERVER_VERSION,
  SITE_URL,
  SNAPSHOT_NOTICE,
  STALENESS_NOTICE,
  TITLE_DISCOVER,
  TITLE_GET_STARTED,
  TOOL_DISCOVER,
  TOOL_GET_STARTED,
} from "./strings.js";

/**
 * Builds the server with every tool registered.
 *
 * `apiKey` is accepted but unused so far: only the free tools ship today. The
 * fee-incurring tools are deliberately absent until the connector-directory
 * eligibility question is answered, because building them before knowing
 * whether they are admissible is how the effort gets wasted.
 */
export function buildServer(apiKey?: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // Free and keyless: always registered, so the server is useful before anyone
  // has signed up. This is the zero-configuration demo path.
  registerDiscover(server);
  registerGetStarted(server);
  // The anonymous preview belongs here rather than behind the key: it is the
  // only keyless tool that shows what is actually being traded, which is the
  // question a prospective user asks before deciding a key is worth obtaining.
  registerPreviewTool(server);

  // Keyed but free per call. Registered only when a key is configured: the spec
  // allows the tool set to vary by the authorization presented, and advertising
  // tools that can only fail is worse than not advertising them.
  if (apiKey?.trim()) {
    const client = new CogDepotClient(apiKey);
    registerAccountTools(server, client);
    registerDealTools(server, client);
    registerMyListingsTool(server, client);
  }

  // Absent by design: browse the metered feed, post, open thread, finalize.
  // Every one spends credits, and whether a fee-incurring tool is admissible to
  // the connector directory is an open question with the review team. Building
  // them before the answer is how the work gets thrown away.
  //
  // The two listing tools above are not exceptions to that: the preview is
  // unauthenticated and free, and /v1/listings/mine is explicitly unmetered.
  // Neither can reach a listing this account did not post, and neither can spend
  // a credit.

  return server;
}

/** Free, keyless. The zero-configuration demo path. */
function registerDiscover(server: McpServer): void {
  server.registerTool(
    TOOL_DISCOVER,
    {
      title: TITLE_DISCOVER,
      description: DESCRIPTION_DISCOVER,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const result = await getFacts();
      return { content: [{ type: "text", text: renderOverview(result) }] };
    },
  );
}

/** Free, keyless. Answers "I have no account, what now". */
function registerGetStarted(server: McpServer): void {
  server.registerTool(
    TOOL_GET_STARTED,
    {
      title: TITLE_GET_STARTED,
      description: DESCRIPTION_GET_STARTED,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const result = await getFacts();
      return { content: [{ type: "text", text: renderOnboarding(result) }] };
    },
  );
}

/** Renders the platform overview, prices last so the caveat sits beside them. */
export function renderOverview(result: FactsResult): string {
  const { facts } = result;
  const lines: string[] = [];

  lines.push(`# ${text(facts.name) ?? "cogDepot"}`);
  const tagline = text(facts.tagline);
  if (tagline) lines.push(tagline);
  const description = text(facts.description);
  if (description) lines.push("", description);

  const credits = record(facts.credits);
  if (credits.length > 0) {
    // This prints the whole `credits` block, including `topUp`, which names
    // Lightning and stablecoins. That is deliberate and is NOT the same call as
    // the one made in errors.ts, which strips those rails out of a 402.
    //
    // The distinction is what the reader is about to do. Here a model is
    // answering "what does this cost and how would I pay" - describing that a
    // service accepts crypto is product information, and omitting it would make
    // the pricing answer incomplete. In a 402 the model is mid-action and one
    // step from acting on payment instructions, which is the case both connector
    // directories bar. Informational, not operational.
    lines.push("", "## Cost");
    for (const [key, value] of credits) lines.push(`- **${key}**: ${value}`);
  }

  const anonymity = text(facts.anonymity);
  if (anonymity) lines.push("", "## Anonymity", anonymity);

  lines.push("", "## Machine-readable contracts");
  for (const [label, url] of [
    ["API base", facts.apiBaseUrl],
    ["Agent card", facts.agentCardUrl],
    ["OpenAPI", facts.openApiUrl],
    ["Website", SITE_URL],
  ] as const) {
    const value = text(url);
    if (value) lines.push(`- ${label}: ${value}`);
  }

  return withProvenance(lines.join("\n"), result);
}

/** Renders the three routes to a key, plus the free funding path. */
export function renderOnboarding(result: FactsResult): string {
  const { facts } = result;
  const lines: string[] = ["# Getting a cogDepot account"];

  const registration = record(facts.registration);
  if (registration.length > 0) {
    lines.push("", "## Open registration (no credentials required)");
    for (const [key, value] of registration) lines.push(`- **${key}**: ${value}`);
  }

  const auth = record(facts.authentication);
  if (auth.length > 0) {
    lines.push("", "## How keys are issued");
    for (const [key, value] of auth) lines.push(`- **${key}**: ${value}`);
  }

  const domainGrant = record(facts.domainGrant);
  if (domainGrant.length > 0) {
    lines.push("", "## Funding it for free by proving domain control");
    for (const [key, value] of domainGrant) lines.push(`- **${key}**: ${value}`);
  }

  lines.push(
    "",
    "Once a key is issued it is returned exactly once and never re-issued. Store it before continuing; a lost key is rotated, not recovered.",
    "",
    `Operators can also sign up on the web at ${SITE_URL}/auth/signup.`,
  );

  return withProvenance(lines.join("\n"), result);
}

/**
 * Appends the honesty line when the numbers above did not come from the live
 * API. Silent on the happy path - a notice on every call trains the reader to
 * ignore it, which is exactly when it stops working.
 */
function withProvenance(body: string, result: FactsResult): string {
  if (result.provenance === "live") return body;

  const notice = result.provenance === "snapshot" ? SNAPSHOT_NOTICE : STALENESS_NOTICE;
  const reason = result.staleReason ? ` (${result.staleReason})` : "";
  return `${body}\n\n${notice}${reason}`;
}

/** Narrows an unknown field to a non-empty string, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** Flattens a string-valued record, skipping anything that is not a string. */
function record(value: unknown): Array<readonly [string, string]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  const out: Array<readonly [string, string]> = [];
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const asText = text(raw);
    if (asText) out.push([key, asText] as const);
  }
  return out;
}

export type { CogDepotFacts, FactsResult };
