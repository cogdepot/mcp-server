/**
 * Negotiation and deal tools. All free per call - the negotiation and deal path
 * is not metered, so none of these are affected by the pending eligibility
 * question. The tools that *do* move credits (post a listing, open a thread,
 * finalize, browse the feed) are deliberately absent until that is answered.
 *
 * Note there is no tool for talking to a counterparty. That is flow A-H, and
 * the broker exits before it: once a deal seals each side gets the other's
 * endpoint and credentials and they transact directly. A messaging tool here
 * would turn a broker into a channel, which is the one thing the architecture
 * refuses to be. Its absence is a design property, not a gap.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import type { CogDepotClient } from "./client.js";
import {
  DESCRIPTION_GET_DEAL,
  DESCRIPTION_GET_THREAD,
  DESCRIPTION_RATE_DEAL,
  TITLE_GET_DEAL,
  TITLE_GET_THREAD,
  TITLE_RATE_DEAL,
  TOOL_GET_DEAL,
  TOOL_GET_THREAD,
  TOOL_RATE_DEAL,
} from "./strings.js";
import { renderRecord } from "./render.js";
import { toolError, toolText } from "./tool-result.js";

/**
 * Drops top-level fields that repeat a value already inside `reveal`.
 *
 * A real sealed deal returns the ~500-character PASETO credential twice: once at
 * the top level and again inside the reveal package. Printing both puts the same
 * deal-scoped secret in a model's context twice, doubling both the token cost
 * and the number of places it can be copied out of.
 *
 * `reveal` is the half that survives, because it is the package a caller is told
 * to store, and truncating it would defeat the instruction to keep it. Only
 * exact value matches are removed, so a top-level field that genuinely differs
 * from its reveal namesake is left alone.
 */
export function withoutRevealDuplicates(
  deal: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!deal) return deal;
  const reveal = deal["reveal"];
  if (typeof reveal !== "object" || reveal === null || Array.isArray(reveal)) return deal;

  const inner = reveal as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(deal)) {
    if (key !== "reveal" && key in inner && inner[key] === value) continue;
    out[key] = value;
  }
  return out;
}

export function registerDealTools(server: McpServer, client: CogDepotClient): void {
  server.registerTool(
    TOOL_GET_THREAD,
    {
      title: TITLE_GET_THREAD,
      description: DESCRIPTION_GET_THREAD,
      inputSchema: z.object({
        thread_id: z.string().min(1).describe("The thread identifier returned when it was opened"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ thread_id }) => {
      try {
        const thread = await client.request<Record<string, unknown>>(
          `/v1/threads/${encodeURIComponent(thread_id)}`,
        );
        return toolText(renderRecord("Negotiation thread", thread));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    TOOL_GET_DEAL,
    {
      title: TITLE_GET_DEAL,
      description: DESCRIPTION_GET_DEAL,
      inputSchema: z.object({
        deal_id: z.string().min(1).describe("The deal identifier returned when the thread sealed"),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ deal_id }) => {
      try {
        const deal = await client.request<Record<string, unknown>>(
          `/v1/deals/${encodeURIComponent(deal_id)}`,
        );
        return toolText(
          `${renderRecord("Sealed deal", withoutRevealDuplicates(deal))}\n\n` +
            "This reveal is available for 7 days after the deal sealed, then the record is purged " +
            "and only aggregate reputation survives. Store anything you need now.",
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    TOOL_RATE_DEAL,
    {
      title: TITLE_RATE_DEAL,
      description: DESCRIPTION_RATE_DEAL,
      inputSchema: z.object({
        deal_id: z.string().min(1).describe("The deal to rate"),
        score: z
          .number()
          .int()
          .min(1)
          .max(5)
          .describe("1 to 5. Folds into the counterparty's aggregate immediately"),
        delivered: z
          .boolean()
          .optional()
          .describe("True affirms delivery, false flags non-delivery, omit to stay silent"),
      }),
      annotations: {
        readOnlyHint: false,
        // A rating is permanent, folds into an aggregate on write, and is never
        // shown back per deal - so it cannot be corrected afterwards. That is
        // destructive in the sense the hint exists for: irreversible.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ deal_id, score, delivered }) => {
      try {
        await client.request(`/v1/deals/${encodeURIComponent(deal_id)}/ratings`, {
          method: "POST",
          body: { score, ...(delivered === undefined ? {} : { delivered }) },
        });
        return toolText(
          `Rated deal ${deal_id} at ${score}/5. It has folded into the counterparty's aggregate ` +
            "and cannot be changed or withdrawn.",
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

