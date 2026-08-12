/**
 * Negotiation and deal tools, covering the whole path from opening a thread to
 * sealing and rating a deal.
 *
 * Most calls here are free: the negotiation path is not metered. Two are not,
 * and they are the two that matter. Opening a thread places a 2,000-credit hold,
 * and finalizing captures 2,000 credits from each side and cannot be undone.
 * Finalize is the only action in this package that is simultaneously
 * irreversible, money-spending and identity-revealing, and it is annotated and
 * described accordingly.
 *
 * Note there is no tool for talking to a counterparty. That is flow A-H, and
 * the broker exits before it: once a deal seals each side gets the other's
 * endpoint and credentials and they transact directly. A messaging tool here
 * would turn a broker into a channel, which is the one thing the architecture
 * refuses to be. Its absence is a design property, not a gap.
 */

import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { newIdempotencyKey, type CogDepotClient } from "./client.js";
import {
  DESCRIPTION_CLOSE_THREAD,
  DESCRIPTION_FINALIZE_DEAL,
  DESCRIPTION_GET_DEAL,
  DESCRIPTION_GET_THREAD,
  DESCRIPTION_LIST_LISTING_THREADS,
  DESCRIPTION_OPEN_THREAD,
  DESCRIPTION_RATE_DEAL,
  DESCRIPTION_SUBMIT_OFFER,
  IDEMPOTENCY_NOTE,
  TITLE_CLOSE_THREAD,
  TITLE_FINALIZE_DEAL,
  TITLE_GET_DEAL,
  TITLE_GET_THREAD,
  TITLE_LIST_LISTING_THREADS,
  TITLE_OPEN_THREAD,
  TITLE_RATE_DEAL,
  TITLE_SUBMIT_OFFER,
  TOOL_CLOSE_THREAD,
  TOOL_FINALIZE_DEAL,
  TOOL_GET_DEAL,
  TOOL_GET_THREAD,
  TOOL_LIST_LISTING_THREADS,
  TOOL_OPEN_THREAD,
  TOOL_RATE_DEAL,
  TOOL_SUBMIT_OFFER,
} from "./strings.js";
import { renderField, renderRecord } from "./render.js";
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

/**
 * Renders the poster's inbox, which arrives as a bare JSON array.
 *
 * `renderRecord` cannot be used here and the first version that did shipped a
 * defect: given an array it iterates the indices, so every thread came out as
 * `- **0**: { ...json... }` with `amount_micro: 1000000` sitting raw inside it.
 * That is the uUSD leak this package exists to prevent, reintroduced through a
 * renderer that was never meant to see a list - and it took a real API response
 * to expose it, because the shape was assumed rather than read.
 *
 * Each thread is rendered field by field instead, so the uUSD conversion and the
 * short-`thread_id` warning both apply exactly as they do on a single thread.
 */
function renderThreadList(heading: string, body: unknown): string {
  const threads = asThreads(body);
  const lines = [`# ${heading}`];

  if (threads.length === 0) {
    lines.push("", "No negotiations have been opened on this listing yet.");
    return lines.join("\n");
  }

  lines.push("", `${threads.length} thread${threads.length === 1 ? "" : "s"}.`);
  for (const thread of threads) {
    const id = typeof thread["id"] === "string" ? thread["id"] : "(unidentified thread)";
    lines.push("", `## Thread ${id}`);
    for (const [key, value] of Object.entries(thread)) {
      if (key === "id") continue; // already the heading
      lines.push(...renderField(key, value));
    }
  }
  return lines.join("\n");
}

/**
 * Narrows the inbox response to an array of threads.
 *
 * Tolerant of a bare array and of a `{threads:[...]}` wrapper. The live staging
 * response is the former; the wrapper is accepted so a later API change does not
 * turn a free read into a failure.
 */
function asThreads(body: unknown): Record<string, unknown>[] {
  const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

  if (Array.isArray(body)) return body.filter(isRecord);
  if (isRecord(body) && Array.isArray(body["threads"])) {
    return (body["threads"] as unknown[]).filter(isRecord);
  }
  return [];
}

/**
 * The negotiation path: open, counter, close, seal.
 *
 * Only two of these move credits, and the annotations say which. `close` and
 * `finalize` are both marked destructive, for different reasons - close ends a
 * negotiation that cannot be reopened, finalize spends money that cannot be
 * refunded and reveals identities that cannot be un-revealed.
 *
 * Every mutating call carries an idempotency key and hands it back, because the
 * failure that matters here is not a rejected call but an ambiguous one: a
 * finalize whose response was lost leaves a model choosing between a possible
 * double charge and a possibly abandoned deal, and the key removes the choice.
 */
export function registerNegotiationTools(server: McpServer, client: CogDepotClient): void {
  server.registerTool(
    TOOL_LIST_LISTING_THREADS,
    {
      title: TITLE_LIST_LISTING_THREADS,
      description: DESCRIPTION_LIST_LISTING_THREADS,
      inputSchema: z.object({
        listing_id: z.string().min(1).describe("One of your own listing ids."),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ listing_id }) => {
      try {
        const threads = await client.request<unknown>(
          `/v1/listings/${encodeURIComponent(listing_id)}/threads`,
        );
        return toolText(renderThreadList(`Negotiations on listing ${listing_id}`, threads));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    TOOL_OPEN_THREAD,
    {
      title: TITLE_OPEN_THREAD,
      description: DESCRIPTION_OPEN_THREAD,
      inputSchema: z.object({
        listing_id: z.string().min(1).describe("The listing to negotiate on. Not your own."),
        diff: z
          .string()
          .min(1)
          .describe(
            "The opening offer: the terms being proposed, in plain language. State price and " +
              "delivery window explicitly rather than saying 'as listed'.",
          ),
        idempotency_key: z
          .string()
          .optional()
          .describe("Pass a previous call's key to retry without placing a second hold."),
      }),
      annotations: {
        readOnlyHint: false,
        // Not destructive: the hold is released if the thread closes or expires,
        // so nothing is permanently lost. It is still 2,000 credits made
        // unavailable, which is why the description leads with that.
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ listing_id, diff, idempotency_key }) => {
      const key = idempotency_key ?? newIdempotencyKey();
      try {
        const thread = await client.request<Record<string, unknown>>(
          `/v1/listings/${encodeURIComponent(listing_id)}/threads`,
          { method: "POST", body: { diff }, idempotencyKey: key },
        );
        return toolText(
          [
            renderRecord("Negotiation opened", thread),
            "",
            "2,000 credits ($1.00) are now held and unavailable to spend. They are captured only " +
              "if this deal seals, and released if the thread is closed or expires unsealed - so " +
              "close a negotiation you have abandoned rather than leaving it to expire.",
            "",
            `idempotency_key: ${key}`,
            IDEMPOTENCY_NOTE,
          ].join("\n"),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    TOOL_SUBMIT_OFFER,
    {
      title: TITLE_SUBMIT_OFFER,
      description: DESCRIPTION_SUBMIT_OFFER,
      inputSchema: z.object({
        thread_id: z.string().min(1).describe("The thread to counter on."),
        diff: z
          .string()
          .min(1)
          .describe("The counter-offer: the full proposed terms, not only what changed."),
        idempotency_key: z
          .string()
          .optional()
          .describe("Pass a previous call's key to retry without submitting twice."),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ thread_id, diff, idempotency_key }) => {
      const key = idempotency_key ?? newIdempotencyKey();
      try {
        const thread = await client.request<Record<string, unknown>>(
          `/v1/threads/${encodeURIComponent(thread_id)}/offers`,
          { method: "POST", body: { diff }, idempotencyKey: key },
        );
        return toolText(
          [
            renderRecord("Counter-offer submitted", thread),
            "",
            "This is now the standing diff. If the counterparty finalizes, these are the terms " +
              "they accept - so it must be terms this side is willing to be held to.",
            "",
            `idempotency_key: ${key}`,
          ].join("\n"),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    TOOL_CLOSE_THREAD,
    {
      title: TITLE_CLOSE_THREAD,
      description: DESCRIPTION_CLOSE_THREAD,
      inputSchema: z.object({
        thread_id: z.string().min(1).describe("The thread to close."),
        idempotency_key: z.string().optional().describe("Pass a previous call's key to retry."),
      }),
      annotations: {
        readOnlyHint: false,
        // Terminal: a closed thread cannot be reopened, and reaching the same
        // counterparty again costs another 2,000-credit hold.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ thread_id, idempotency_key }) => {
      const key = idempotency_key ?? newIdempotencyKey();
      try {
        await client.request(`/v1/threads/${encodeURIComponent(thread_id)}/close`, {
          method: "POST",
          body: {},
          idempotencyKey: key,
        });
        return toolText(
          `Thread ${thread_id} is closed and cannot be reopened. Any escrow hold it carried has ` +
            "been released back to spendable - confirm with cogdepot_get_account. Reaching this " +
            "counterparty again means a new thread and a new 2,000-credit hold.",
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    TOOL_FINALIZE_DEAL,
    {
      title: TITLE_FINALIZE_DEAL,
      description: DESCRIPTION_FINALIZE_DEAL,
      inputSchema: z.object({
        thread_id: z.string().min(1).describe("The thread whose standing terms are being accepted."),
        idempotency_key: z
          .string()
          .optional()
          .describe(
            "Pass a previous call's key to retry safely. Without it a repeat is a second, " +
              "separately charged attempt.",
          ),
      }),
      annotations: {
        readOnlyHint: false,
        // The strongest claim this package makes about any tool. Irreversible,
        // spends 2,000 credits per side, and permanently ends the anonymity that
        // is cogDepot's whole premise. A host that prompts on anything should
        // prompt on this.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ thread_id, idempotency_key }) => {
      const key = idempotency_key ?? newIdempotencyKey();
      try {
        const deal = await client.request<Record<string, unknown>>(
          `/v1/threads/${encodeURIComponent(thread_id)}/finalize`,
          { method: "POST", body: {}, idempotencyKey: key },
        );
        return toolText(
          [
            renderRecord("Deal sealed", withoutRevealDuplicates(deal)),
            "",
            "2,000 credits ($1.00) have been taken from each side. The reveal above is the " +
              "counterparty's real endpoint, credentials and contact: cogDepot's part is over and " +
              "the two of you transact directly from here.",
            "",
            "The record is purged 7 days from now, after which only aggregate reputation survives. " +
              "Store the reveal now, and rate the counterparty with cogdepot_rate_deal inside that window.",
            "",
            `idempotency_key: ${key}`,
            IDEMPOTENCY_NOTE,
          ].join("\n"),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

