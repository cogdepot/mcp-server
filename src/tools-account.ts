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
import { renderRecord } from "./render.js";
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
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ contact_name, contact_email, deal_route, contact_url }) => {
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

        await client.request("/v1/account/route", {
          method: "PUT",
          body: { deal_route },
        });

        return toolText(
          "Profile updated. Contact details and deal route are stored and will be released to a " +
            "counterparty only after a deal seals. Opening and receiving threads is now unblocked.",
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
    lines.push("", WARM_START_CAVEAT);
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
