/**
 * Account tools. All free per call - none of these are metered, so none are
 * affected by the pending directory-eligibility question.
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
  WARM_START_CAVEAT,
} from "./strings.js";
import { toolError, toolText } from "./tool-result.js";

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
        // state-changing call run unprompted, and annotation accuracy is
        // checked in directory review.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const account = await client.request<AccountResponse>("/v1/account");
        return toolText(renderAccount(account, await currentMeteredCallText()));
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
        contact_email: z
          .string()
          .min(3)
          .describe("Operator email, released only after a deal seals"),
        deal_route: z
          .string()
          .url()
          .describe("Your https route base for per-deal contact, released only after a deal seals"),
        contact_url: z.string().url().optional().describe("Optional https contact URL"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ contact_name, contact_email, deal_route, contact_url }) => {
      try {
        await client.request("/v1/account/contact", {
          method: "PUT",
          body: {
            contact_name,
            contact_email,
            ...(contact_url === undefined ? {} : { contact_url }),
          },
        });
        await client.request("/v1/account/route", {
          method: "PUT",
          body: { deal_route },
        });
        return toolText(
          "Profile updated. Contact details and deal route are stored and will be released to a " +
            "counterparty only after a deal seals. Opening and receiving threads is now unblocked.",
        );
      } catch (error) {
        return toolError(error);
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
  meteredCallText: unknown,
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
    lines.push("", WARM_START_CAVEAT);
  }

  if (!creditRateLooksCurrent(meteredCallText)) {
    lines.push(
      "",
      "WARNING: the live pricing text no longer states $0.0005 per credit, so the dollar figures " +
        "above may be converted at an outdated rate. Trust the credit counts, not the dollars.",
    );
  }

  return lines.join("\n");
}

/** Generic key/value rendering for the small responses. */
function renderRecord(heading: string, body: Record<string, unknown> | undefined): string {
  if (!body) return `${heading}: the API returned no content.`;
  const lines = [`# ${heading}`];
  for (const [key, value] of Object.entries(body)) {
    lines.push(`- **${key}**: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
  }
  return lines.join("\n");
}

/** The live metered-call sentence, used to sanity-check the credit rate. */
async function currentMeteredCallText(): Promise<unknown> {
  const { facts } = await getFacts();
  return facts.credits?.["meteredCall"];
}
