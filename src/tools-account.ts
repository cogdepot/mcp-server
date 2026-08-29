/**
 * Account tools. All free per call - none of these are metered.
 *
 * Deliberately absent: a `register_account` tool. Registration requires sending
 * `accepted_terms: true`, and a tool that accepts a legal agreement on a user's
 * behalf without them seeing it is the wrong default - it is also the shape a
 * directory reviewer would flag. `cogdepot_get_started` explains the route and
 * the user performs it. Revisit if elicitation support becomes universal enough
 * to put the Terms in front of a human reliably.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { CogDepotClient } from "./client.js";
import { getFacts } from "./facts.js";
import { creditRateLooksCurrent, describeBalance } from "./money.js";
import {
  DESCRIPTION_GET_ACCOUNT,
  DESCRIPTION_GET_DOMAIN_CHALLENGE,
  DESCRIPTION_UPDATE_PROFILE,
  DESCRIPTION_VERIFY_DOMAIN,
  TITLE_GET_ACCOUNT,
  TITLE_GET_DOMAIN_CHALLENGE,
  TITLE_UPDATE_PROFILE,
  TITLE_VERIFY_DOMAIN,
  TOOL_GET_ACCOUNT,
  TOOL_GET_DOMAIN_CHALLENGE,
  TOOL_UPDATE_PROFILE,
  TOOL_VERIFY_DOMAIN,
  MONEY_GATED_REPUTATION_CAVEAT,
  WARM_START_CAVEAT,
} from "./strings.js";
import { renderRecord } from "./render.js";
import { toolError, toolText } from "./tool-result.js";

/**
 * The three protocol bindings an operator may declare for their deal route.
 *
 * Two are A2A v1.0 bindings, spelled the way A2A spells them. The third is a
 * cogDepot identifier for a plain HTTPS webhook taking JSON, NOT an A2A custom
 * binding - the URI resolves to its own spec page. Kept in the order the API
 * documents them so a reader comparing the two sees the same list.
 */
const ROUTE_PROTOCOL_BINDINGS = [
  "JSONRPC",
  "HTTP+JSON",
  "https://cogdepot.com/bindings/webhook-v1",
] as const;

/**
 * Hostnames the API refuses in an Agent Card URL.
 *
 * A card is fetched by the COUNTERPARTY, from their network, so an address that
 * only resolves on the declaring operator's machine cannot be reached and a
 * private-range one points at whatever happens to sit at that address on the
 * reader's network instead. The API rejects these; this repeats the rule at the
 * boundary so the caller learns which field was wrong rather than reading a 400.
 */
function isUnreachableCardHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  // URL.hostname KEEPS the brackets on an IPv6 literal ("[::1]", not "::1"),
  // so they come off before any address comparison. Checked by test: the first
  // version of this compared the bracketed form and passed every v6 address.
  const ip6 = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (ip6 === "::1" || ip6 === "::") return true;
  if (/^fe[89ab][0-9a-f]:/.test(ip6)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}:/.test(ip6)) return true; // fc00::/7 unique-local

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = v4.slice(1).map(Number);
  if (a === undefined || b === undefined) return false;
  if (a === 0) return true; // 0.0.0.0/8 unspecified
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  return false;
}

/**
 * Whether a string satisfies every Agent Card URL rule the API enforces.
 *
 * Stricter than "an https URL", and deliberately so: the API refuses a query
 * string, a fragment and a trailing slash as well. A normal card path such as
 * https://acme.example/.well-known/agent-card.json satisfies all of it, while
 * https://acme.example/card.json?v=2 does not. Checking here turns a 400 the
 * caller has to decode into a schema message naming the field.
 */
export function isValidAgentCardUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.search !== "" || url.hash !== "") return false;
  // A bare origin has pathname "/", which is a trailing slash and also not a
  // card location, so it is refused by the same rule rather than a second one.
  if (url.pathname.endsWith("/")) return false;
  return !isUnreachableCardHost(url.hostname);
}

interface AccountResponse {
  readonly account_id?: string;
  readonly balance_micro?: number;
  readonly held_micro?: number;
  readonly status?: string;
  readonly reputation?: Record<string, unknown>;
}

export function registerAccountTools(server: McpServer, client: CogDepotClient): void {
  server.registerTool(
    TOOL_GET_ACCOUNT,
    {
      title: TITLE_GET_ACCOUNT,
      description: DESCRIPTION_GET_ACCOUNT,
      inputSchema: z.object({}),
      annotations: {
        // NOT read-only, and this is not pedantry: the API's own field
        // description says "expired holds settled lazily on read". The hints
        // drive auto-permissions, so claiming read-only would let a
        // state-changing call run unprompted.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const account = await client.request<AccountResponse>("/v1/account");
        return toolText(renderAccount(account, await currentRateText()));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    TOOL_UPDATE_PROFILE,
    {
      title: TITLE_UPDATE_PROFILE,
      description: DESCRIPTION_UPDATE_PROFILE,
      inputSchema: z.object({
        contact_name: z.string().min(1).describe("Operator name, released only after a deal seals"),
        // Validate at the boundary rather than letting the API reject it. A
        // model that gets "invalid email" back from a schema can fix it and
        // retry; one that gets a 400 from a write it thought would succeed has
        // to work out which of four fields was wrong.
        contact_email: z
          .string()
          .email()
          .describe("Operator email, released only after a deal seals"),
        // https only, not merely a URL. The API requires it, and `.url()` alone
        // would happily accept an http:// route that then fails server-side.
        deal_route: z
          .string()
          .url()
          .startsWith("https://", "must be an https URL")
          .describe("Your https route base for per-deal contact, released only after a deal seals"),
        contact_url: z
          .string()
          .url()
          .startsWith("https://", "must be an https URL")
          .optional()
          .describe("Optional https contact URL"),
        // Optional, and the cost of omitting it is the whole reason it exists:
        // only the operator can say what answers at their own endpoint, so
        // cogDepot will not assert one on their behalf.
        route_protocol_binding: z
          .enum(ROUTE_PROTOCOL_BINDINGS)
          .optional()
          .describe(
            "Optional. What protocol answers at your deal_route, and the one thing only you can " +
              "state truthfully. JSONRPC = an A2A v1.0 JSON-RPC endpoint answers there. " +
              "HTTP+JSON = an A2A v1.0 HTTP+JSON/REST endpoint. " +
              "https://cogdepot.com/bindings/webhook-v1 = a plain HTTPS webhook taking JSON, whose " +
              "payload semantics you and the counterparty agree during the negotiation (a cogDepot " +
              "identifier, NOT an A2A custom binding). Omit it and your counterparty's reveal " +
              "carries NO interface descriptor at all - just your endpoint and operator contact - " +
              "rather than a protocol claim you never made. REPLACE-ON-WRITE: this call rewrites " +
              "the whole route declaration, so omitting it CLEARS any binding set earlier.",
          ),
        agent_card_url: z
          .string()
          .refine(isValidAgentCardUrl, {
            message:
              "must be an absolute https URL with no query string, no fragment and no trailing " +
              "slash, and not a localhost or loopback/link-local/private/unspecified address",
          })
          .optional()
          .describe(
            "Optional. Where your A2A Agent Card is published. Revealed to a sealed counterparty " +
              "as counterparty_agent_card_url so their client reads supportedInterfaces and " +
              "securitySchemes from you directly instead of relying on cogDepot's relayed " +
              "descriptor. STRICTER THAN https: absolute https:// with NO query string, NO " +
              "fragment and NO trailing slash, and the host may not be localhost or a loopback, " +
              "link-local, private-range or unspecified IP literal. " +
              "https://acme.example/.well-known/agent-card.json is valid; " +
              "https://acme.example/card.json?v=2 is not. REPLACE-ON-WRITE: omitting it CLEARS " +
              "any card URL set earlier.",
          ),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      contact_name,
      contact_email,
      deal_route,
      contact_url,
      route_protocol_binding,
      agent_card_url,
    }) => {
      // Two endpoints, one tool. They cannot be written atomically, so the
      // partial outcome has to be reported rather than hidden: if the contact
      // write lands and the route write fails, a bare error would tell the
      // caller nothing was saved when half of it was, and a retry would look
      // like it was starting from scratch. Both writes are idempotent, so
      // retrying is safe - the caller just needs to know where it got to.
      let contactWritten = false;
      try {
        await client.request("/v1/account/contact", {
          method: "PUT",
          body: {
            contact_name,
            contact_email,
            ...(contact_url === undefined ? {} : { contact_url }),
          },
        });
        contactWritten = true;

        // The route write REPLACES the whole declaration, so an undeclared
        // field is sent as absent rather than as null: that is what clears it,
        // and it is the same thing the caller omitting the argument asked for.
        await client.request("/v1/account/route", {
          method: "PUT",
          body: {
            deal_route,
            ...(route_protocol_binding === undefined ? {} : { route_protocol_binding }),
            ...(agent_card_url === undefined ? {} : { agent_card_url }),
          },
        });

        // Naming what was NOT declared matters more than confirming what was:
        // the route write just replaced the whole declaration, so a caller who
        // set a binding on an earlier call and omitted it here has silently
        // cleared it. Saying so is the only warning they get.
        const declared = [
          route_protocol_binding === undefined
            ? undefined
            : `protocol binding ${route_protocol_binding}`,
          agent_card_url === undefined ? undefined : `agent card ${agent_card_url}`,
        ].filter((part): part is string => part !== undefined);

        return toolText(
          "Profile updated. Contact details and deal route are stored and will be released to a " +
            "counterparty only after a deal seals. Opening and receiving threads is now " +
            "unblocked.\n\n" +
            (declared.length > 0
              ? `Route declaration: ${declared.join(", ")}.`
              : "No protocol binding or agent card was declared, so a sealed counterparty " +
                "receives your endpoint and contact with no interface descriptor.") +
            " A route write replaces the whole declaration, so anything not passed here is now " +
            "cleared.",
        );
      } catch (error) {
        const partial = toolError(error);
        if (!contactWritten) return partial;
        return {
          ...partial,
          content: [
            {
              type: "text" as const,
              text:
                `Partly applied: the contact details WERE saved, the deal route was NOT.\n\n` +
                `${partial.content[0]?.text ?? ""}\n\n` +
                "Re-running this tool is safe - both writes are idempotent. Until the route is " +
                "set, opening and receiving threads stays blocked.",
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    TOOL_GET_DOMAIN_CHALLENGE,
    {
      title: TITLE_GET_DOMAIN_CHALLENGE,
      description: DESCRIPTION_GET_DOMAIN_CHALLENGE,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const challenge = await client.request<Record<string, unknown>>("/v1/account/domain");
        return toolText(renderRecord("Domain verification challenge", challenge));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    TOOL_VERIFY_DOMAIN,
    {
      title: TITLE_VERIFY_DOMAIN,
      description: DESCRIPTION_VERIFY_DOMAIN,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        // Not idempotent in effect: the grant pays once per domain and once per
        // account, and repeated failures are rate limited per account.
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const result = await client.request<Record<string, unknown>>("/v1/account/domain/verify", {
          method: "POST",
        });
        return toolText(renderRecord("Domain verified", result));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

/** Renders an account without ever exposing a µUSD figure. */
export function renderAccount(
  account: AccountResponse | undefined,
  rateText: unknown,
): string {
  if (!account) return "The API returned an empty account record.";

  const balance = describeBalance(account.balance_micro, account.held_micro);
  const lines = [
    "# cogDepot account",
    `- Spendable: **${balance.credits.toLocaleString("en-US")} credits** (${balance.usd})`,
    `- Held in escrow: ${balance.heldCredits.toLocaleString("en-US")} credits (${balance.heldUsd})`,
  ];
  if (account.status) lines.push(`- Status: ${account.status}`);

  const reputation = account.reputation;
  if (reputation && typeof reputation === "object") {
    lines.push("", "## Reputation");
    for (const [role, value] of Object.entries(reputation)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const facet = value as Record<string, unknown>;
        const sum = Number(facet["rating_sum"] ?? 0);
        const count = Number(facet["rating_count"] ?? 0);
        // `count` is 0 only if the warm-start rating is absent, which the API
        // never does today - but a mean of NaN is a worse thing to show a model
        // than "n/a", so the guard stays and is covered by a test.
        const mean = count > 0 ? (sum / count).toFixed(1) : "n/a";
        const real = Math.max(0, count - 1);
        lines.push(
          `- **${role}**: ${mean} over ${count} rating(s) - ${real} from real counterparties; ` +
            `${facet["finalized_count"] ?? 0} finalized deal(s)`,
        );
      } else {
        lines.push(`- ${role}: ${String(value)}`);
      }
    }
    lines.push("", WARM_START_CAVEAT, "", MONEY_GATED_REPUTATION_CAVEAT);
  }

  if (!creditRateLooksCurrent(rateText)) {
    lines.push(
      "",
      "WARNING: the live pricing text no longer states $0.0005 per credit, so the dollar figures " +
        "above may be converted at an outdated rate. Trust the credit counts, not the dollars.",
    );
  }

  return lines.join("\n");
}


/**
 * The live statement of the credit rate, used to sanity-check the constant this
 * package converts with.
 *
 * Prefers `credits.unit` - "1 credit = $0.0005 USD" - which is the canonical
 * statement, and falls back to the metered-call sentence, which mentions the
 * same figure incidentally. If cogDepot ever reprices a credit, converting at
 * the old rate would produce confidently wrong dollar figures, which is the
 * worst failure available here.
 */
async function currentRateText(): Promise<unknown> {
  const { facts } = await getFacts();
  return facts.credits?.["unit"] ?? facts.credits?.["meteredCall"];
}
