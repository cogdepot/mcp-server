/**
 * Prompts: the workflows, as opposed to the individual calls.
 *
 * A tool answers "what can this server do". A prompt answers "what am I trying
 * to get done", which on cogDepot is always a sequence - post then watch, search
 * then negotiate, read then seal then rate. Shipping the sequences means a user
 * does not have to reconstruct them from nineteen tool descriptions.
 *
 * **Prompts are user-initiated, and that is why they are safe.** A person picks
 * one from a client's menu; nothing here is auto-invoked the way a tool can be.
 * So a prompt may freely name a tool that spends credits - it is describing a
 * plan to a user who chose to see it, not taking an action. Each one still
 * repeats the price, because the model that reads the plan is the same model
 * that will call the tool, and the description it reads at that moment is the
 * last thing standing between a plan and a charge.
 *
 * **They are registered on the same rule as tools**: keyed prompts appear only
 * when a credential is configured. A prompt whose every step is a tool the user
 * does not have is worse than an absent one - it reads as a feature and behaves
 * as a dead end. `cogdepot_plan_my_spend` is the exception and is always
 * present, because deciding whether cogDepot is worth a key is exactly the
 * question a user without one has.
 *
 * Nothing here calls the API. Prompt callbacks return text; the tools they name
 * do the work. That keeps a prompt from being a way to spend money by opening a
 * menu.
 */

import { completable, type McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { listPreviewCategories } from "./tools-listings.js";
import {
  DESCRIPTION_CLOSE_OUT_A_DEAL,
  DESCRIPTION_FIND_A_COUNTERPARTY,
  DESCRIPTION_PLAN_MY_SPEND,
  DESCRIPTION_SELL_A_CAPABILITY,
  DESCRIPTION_TRIAGE_MY_THREADS,
  PROMPT_CLOSE_OUT_A_DEAL,
  PROMPT_FIND_A_COUNTERPARTY,
  PROMPT_PLAN_MY_SPEND,
  PROMPT_SELL_A_CAPABILITY,
  PROMPT_TRIAGE_MY_THREADS,
  TITLE_CLOSE_OUT_A_DEAL,
  TITLE_FIND_A_COUNTERPARTY,
  TITLE_PLAN_MY_SPEND,
  TITLE_SELL_A_CAPABILITY,
  TITLE_TRIAGE_MY_THREADS,
  TOOL_BROWSE_FEED,
  TOOL_CLOSE_THREAD,
  TOOL_DISCOVER,
  TOOL_FINALIZE_DEAL,
  TOOL_GET_ACCOUNT,
  TOOL_GET_DEAL,
  TOOL_GET_LISTING,
  TOOL_GET_MY_LISTINGS,
  TOOL_GET_THREAD,
  TOOL_LIST_LISTING_THREADS,
  TOOL_OPEN_THREAD,
  TOOL_POST_LISTING,
  TOOL_PREVIEW_LISTINGS,
  TOOL_RATE_DEAL,
  TOOL_SUBMIT_OFFER,
} from "./strings.js";

/** Shapes a single-message prompt result, which is all any of these needs. */
function userMessage(text: string) {
  return { messages: [{ role: "user" as const, content: { type: "text" as const, text } }] };
}

/**
 * Completes a category argument from the keyless listing preview.
 *
 * The source matters more than the feature. `cogdepot_browse_feed` also knows
 * the live categories and costs a credit per call, and a completion fires on
 * keystrokes - wiring autocomplete to a metered endpoint would let a user spend
 * dollars by typing. The preview is free, keyless and cached, so this cannot.
 *
 * Failure is silent by design: an autocomplete that surfaces a network error
 * into a text field is worse than one that offers nothing.
 */
async function completeCategory(value: string | undefined): Promise<string[]> {
  let categories: string[];
  try {
    categories = await listPreviewCategories();
  } catch {
    return [];
  }
  // `value` is undefined on the first keystroke of an optional argument, which
  // is the case that should offer everything rather than nothing.
  const needle = (value ?? "").trim().toLowerCase();
  const matches = needle
    ? categories.filter((c) => c.toLowerCase().includes(needle))
    : categories;
  // The spec caps a completion response at 100 values.
  return matches.slice(0, 100);
}

/** Free and keyless. Always registered - see the module note. */
export function registerKeylessPrompts(server: McpServer): void {
  server.registerPrompt(
    PROMPT_PLAN_MY_SPEND,
    {
      title: TITLE_PLAN_MY_SPEND,
      description: DESCRIPTION_PLAN_MY_SPEND,
      argsSchema: z.object({}),
    },
    () =>
      userMessage(
        [
          "I want to understand what using cogDepot would cost me before I do anything that spends.",
          "",
          `1. Call ${TOOL_DISCOVER} and summarise what cogDepot is and what it charges. Take the prices from that response rather than from memory - they are read live and they change.`,
          `2. Call ${TOOL_PREVIEW_LISTINGS} and tell me what is actually being traded right now, so I can judge whether the marketplace is worth joining.`,
          "",
          "Then lay out, in a short table, what each thing I might do costs:",
          `- searching the feed (${TOOL_BROWSE_FEED}) and reading one listing in full (${TOOL_GET_LISTING})`,
          `- posting a listing of my own (${TOOL_POST_LISTING}), separating the posting fee from the metered call`,
          `- opening a negotiation (${TOOL_OPEN_THREAD}), and be explicit that this is a HOLD rather than a spend: say what releases it and what captures it`,
          `- sealing a deal (${TOOL_FINALIZE_DEAL}), noting that both sides pay and that it cannot be undone`,
          "",
          "Finish by telling me which actions are free, and how I could get credits without paying for them.",
          "Do not call any tool that costs credits while answering this - everything above is answerable from the free ones.",
        ].join("\n"),
      ),
  );
}

/** Keyed. Registered only when a credential is configured. */
export function registerKeyedPrompts(server: McpServer): void {
  registerSellACapability(server);
  registerFindACounterparty(server);
  registerTriageMyThreads(server);
  registerCloseOutADeal(server);
}

function registerSellACapability(server: McpServer): void {
  server.registerPrompt(
    PROMPT_SELL_A_CAPABILITY,
    {
      title: TITLE_SELL_A_CAPABILITY,
      description: DESCRIPTION_SELL_A_CAPABILITY,
      argsSchema: z.object({
        offer: z.string().describe("What you can do for a counterparty, in your own words."),
        asking_price_usd: z
          .string()
          .optional()
          .describe("What you want for it, in dollars, e.g. 25. Leave empty to be advised."),
        // `.optional()` goes OUTSIDE `completable`, not inside. The mark is a
        // symbol set on the schema object itself, and the SDK unwraps an
        // optional before testing for it - so marking the wrapper leaves the
        // inner schema unmarked, the completion handler is never registered,
        // and the request comes back -32601 with nothing else to show for it.
        category: completable(
          z.string().describe("The category to list under. Completes from live listings."),
          completeCategory,
        ).optional(),
      }),
    },
    ({ offer, asking_price_usd, category }) =>
      userMessage(
        [
          `I want to sell this on cogDepot: ${offer}`,
          asking_price_usd ? `My asking price is $${asking_price_usd}.` : "I have not settled on a price yet.",
          category ? `I think it belongs in the "${category}" category.` : "",
          "",
          `1. Call ${TOOL_GET_ACCOUNT} first and tell me my spendable balance. Posting costs 201 credits, so if I cannot cover it, stop here and tell me how to fund the account instead.`,
          asking_price_usd
            ? ""
            : `2. Call ${TOOL_PREVIEW_LISTINGS} and suggest a price from what comparable listings are asking. Tell me the range you saw, not just a number.`,
          `3. Draft the listing - title, description, category, price - and SHOW IT TO ME. Do not post it yet.`,
          `4. Only after I approve the draft, call ${TOOL_POST_LISTING}. Tell me the 201-credit charge is about to happen before you make the call, and report my balance afterwards.`,
          `5. Then call ${TOOL_GET_MY_LISTINGS} to confirm it is live, and tell me to check back with ${TOOL_LIST_LISTING_THREADS} for responses.`,
          "",
          "Posting is the one step here that spends. Do not skip the approval in step 3.",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
  );
}

function registerFindACounterparty(server: McpServer): void {
  server.registerPrompt(
    PROMPT_FIND_A_COUNTERPARTY,
    {
      title: TITLE_FIND_A_COUNTERPARTY,
      description: DESCRIPTION_FIND_A_COUNTERPARTY,
      argsSchema: z.object({
        need: z.string().describe("What you are looking for, in your own words."),
        category: completable(
          z.string().describe("Narrow the search to one category. Completes from live listings."),
          completeCategory,
        ).optional(),
        listing_type: z
          .enum(["buy", "sell"])
          .optional()
          .describe("sell = someone offering work, buy = someone requesting it."),
      }),
    },
    ({ need, category, listing_type }) =>
      userMessage(
        [
          `I am looking for this on cogDepot: ${need}`,
          category ? `Search the "${category}" category.` : "",
          listing_type ? `Filter to listings of type "${listing_type}".` : "",
          "",
          `1. Call ${TOOL_GET_ACCOUNT} and tell me my balance. Each search costs 1 credit and opening a negotiation places a 2,000-credit hold, so tell me up front whether I can afford to negotiate at all.`,
          `2. Call ${TOOL_BROWSE_FEED} with the filters above. Each call costs 1 credit - page deliberately, and tell me what each page cost.`,
          `3. Shortlist the candidates worth a closer look and tell me why. Only call ${TOOL_GET_LISTING} for the ones I agree to, since each full read is another credit.`,
          `4. When I pick one, call ${TOOL_OPEN_THREAD} with an opening offer we have agreed on. Tell me before you do that this places a 2,000-credit HOLD - not a spend - and say exactly what releases it.`,
          `5. Use ${TOOL_SUBMIT_OFFER} to counter. Remember that only the listing's poster can seal, so my last offer is what they would be accepting.`,
          `6. If it goes nowhere, call ${TOOL_CLOSE_THREAD} to release the hold rather than leaving it to expire.`,
          "",
          "Tell me the running total spent at each step.",
        ]
          .filter(Boolean)
          .join("\n"),
      ),
  );
}

function registerTriageMyThreads(server: McpServer): void {
  server.registerPrompt(
    PROMPT_TRIAGE_MY_THREADS,
    {
      title: TITLE_TRIAGE_MY_THREADS,
      description: DESCRIPTION_TRIAGE_MY_THREADS,
      argsSchema: z.object({}),
    },
    () =>
      userMessage(
        [
          "Show me where every cogDepot negotiation I am part of currently stands.",
          "",
          `1. Call ${TOOL_GET_MY_LISTINGS} for the listings I have posted.`,
          `2. For each one, call ${TOOL_LIST_LISTING_THREADS} to see who has opened a negotiation against it.`,
          `3. Call ${TOOL_GET_THREAD} on each active thread and read the standing offer.`,
          "",
          "Then give me one table: thread, listing, counterparty's standing offer, and whose move it is.",
          "Flag separately any thread where I am the poster and the standing offer is one I could seal right now, since that is the only case where I can act unilaterally.",
          "",
          `Every call in this workflow is free. Do not call ${TOOL_BROWSE_FEED} or ${TOOL_GET_LISTING} while answering - they are metered and they are not needed here.`,
          `Do not call ${TOOL_FINALIZE_DEAL}. This is a review, not a decision.`,
        ].join("\n"),
      ),
  );
}

function registerCloseOutADeal(server: McpServer): void {
  server.registerPrompt(
    PROMPT_CLOSE_OUT_A_DEAL,
    {
      title: TITLE_CLOSE_OUT_A_DEAL,
      description: DESCRIPTION_CLOSE_OUT_A_DEAL,
      argsSchema: z.object({
        thread_id: z.string().describe("The negotiation thread to close out."),
      }),
    },
    ({ thread_id }) =>
      userMessage(
        [
          `I want to close out cogDepot thread ${thread_id}.`,
          "",
          `1. Call ${TOOL_GET_THREAD} on it and show me the standing offer in full - the exact terms, not a summary. ${TOOL_FINALIZE_DEAL} accepts those terms verbatim.`,
          `2. Call ${TOOL_GET_ACCOUNT} and confirm I can cover 2,000 credits.`,
          "3. Then STOP and ask me whether to seal. Tell me plainly, in the same message, that sealing:",
          "   - spends 2,000 credits from each side",
          "   - cannot be undone",
          "   - releases my contact details and deal route to the counterparty, ending the anonymity permanently",
          `   - is poster-only, so if I did not post the listing, ${TOOL_FINALIZE_DEAL} will refuse and nothing will be charged`,
          `4. Only on my explicit yes, call ${TOOL_FINALIZE_DEAL}.`,
          `5. Afterwards, call ${TOOL_GET_DEAL} for the reveal and tell me the handover window before it expires.`,
          `6. Finally, offer to call ${TOOL_RATE_DEAL}. Rating has its own window and one rating per side.`,
          "",
          "Step 3 is not optional. Do not seal without my explicit approval of the specific terms.",
        ].join("\n"),
      ),
  );
}
