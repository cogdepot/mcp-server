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

import { CogDepotClient, type Credential } from "./client.js";
import { getFacts, type CogDepotFacts, type FactsResult } from "./facts.js";
import { registerKeyedPrompts, registerKeylessPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { registerAccountTools } from "./tools-account.js";
import { registerReputationTool } from "./tools-reputation.js";
import { registerDealTools, registerNegotiationTools } from "./tools-deals.js";
import {
  registerMeteredListingTools,
  registerMyListingsTool,
  registerPreviewTool,
} from "./tools-listings.js";
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
  USER_AGENT,
} from "./strings.js";

/**
 * Builds the server with every tool registered.
 *
 * The tool set varies by one thing only: whether a credential is configured.
 * Without one, the three keyless tools answer and nothing else is advertised,
 * because a tool that can only fail is worse than an absent one. The credential
 * is either an API key (stdio's env var, the Phase 1 static header) or a relayed
 * OAuth access token (the remote OAuth path); both resolve to an account on the
 * cogDepot side, so the keyed tool set is identical either way.
 *
 * Tools that spend credits ship. They were absent through 0.1.4 behind a note
 * about connector-directory eligibility, which turned out to be a design-time
 * precaution from the first commit that had been repeated into eight files until
 * it read as an external ruling. No ruling was ever sought or given. What
 * governs them now is the real constraint - they cost the user money - and that
 * is handled where it belongs: prices stated in the descriptions a model reads
 * before calling, accurate destructive and read-only hints for hosts to prompt
 * on, and an idempotency key on every mutating call so an ambiguous outcome is
 * not resolved by charging twice.
 *
 * `userAgent` names the deployment in cogDepot's request logs. It defaults to
 * the local install string and is overridden only by the hosted entrypoint,
 * which passes REMOTE_USER_AGENT - see remote.ts. It reaches both the
 * authenticated client and the two keyless tools that call out on their own.
 */
export function buildServer(
  credential?: string | Credential,
  userAgent: string = USER_AGENT,
): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // Free and keyless: always registered, so the server is useful before anyone
  // has signed up. This is the zero-configuration demo path.
  registerDiscover(server);
  registerGetStarted(server);
  // Documents rather than actions: what cogDepot is, what it costs, how to get
  // an account. Free, unauthenticated and genuinely read-only, which is the
  // whole admission criterion - see resources.ts for what is deliberately not
  // here and why the metered surface stays behind tools.
  registerResources(server);
  // Workflows rather than calls. User-initiated, so nothing here can spend on
  // its own; this one is keyless because deciding whether cogDepot is worth a
  // key is the question a user without one has.
  registerKeylessPrompts(server);
  // The anonymous preview belongs here rather than behind the key: it is the
  // only keyless tool that shows what is actually being traded, which is the
  // question a prospective user asks before deciding a key is worth obtaining.
  registerPreviewTool(server, userAgent);
  // Keyless for the same reason, one step further out: this one answers a
  // question about a counterparty rather than about the market. The party who
  // most needs a trust signal is the one deciding whether to deal at all, and
  // that party does not have an account yet - so a key gate here would publish
  // the record only to people who had already decided.
  registerReputationTool(server, userAgent);

  // Keyed but free per call. Registered only when a credential is present: the
  // spec allows the tool set to vary by the authorization presented, and
  // advertising tools that can only fail is worse than not advertising them. The
  // client normalizes a blank credential to none, so hasKey is the single source
  // of truth for "is there something to authenticate with".
  const client = new CogDepotClient(credential, undefined, undefined, userAgent);
  if (client.hasKey) {
    registerAccountTools(server, client);
    registerDealTools(server, client);
    registerMyListingsTool(server, client);

    // The rest of the market: browsing, posting, negotiating and sealing. These
    // are separated into their own registrars not because they are gated but
    // because they are the ones that cost money, and a reader asking "what can
    // this spend" should find the answer in one place.
    registerMeteredListingTools(server, client);
    registerNegotiationTools(server, client);

    // The keyed workflows, on the same rule as the keyed tools: a prompt whose
    // every step names a tool this server did not register reads as a feature
    // and behaves as a dead end.
    registerKeyedPrompts(server);
  }

  // Still absent, and this one is a real decision rather than an inherited one:
  // POST /dashboard/credits, which tops up a balance. It moves actual money in,
  // and its live description names Lightning and stablecoin rails - the same
  // payment instructions errors.ts strips out of a 402 before a model can act on
  // them. Buying credits is a thing a person does on the website, having decided
  // to spend, not a thing an agent does mid-task.

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
