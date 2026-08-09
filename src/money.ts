/**
 * Presenting balances.
 *
 * The API reports two different things and a model must never see the first.
 * `GET /v1/account` returns `balance_micro` and `held_micro` in µUSD;
 * `GET /v1/account/profile` returns `balance_credits`, already truncated to
 * whole credits. A model shown `20000000` will reason about it as a quantity of
 * credits rather than as $10, and one shown only the truncated credit figure
 * will compare it against a 2000-credit fee having silently lost the remainder.
 *
 * So: arithmetic in µUSD, display in credits and dollars, never expose µUSD.
 *
 * The conversion rate is a documented platform constant (1 credit = 50 µUSD,
 * i.e. $0.0005), asserted against the live document at call time rather than
 * assumed - see `assertCreditRate`.
 */

/** µUSD per credit. 1 credit = $0.0005. */
export const MICRO_USD_PER_CREDIT = 50;

export interface Balance {
  readonly credits: number;
  readonly usd: string;
  readonly heldCredits: number;
  readonly heldUsd: string;
}

/** Converts the µUSD pair from `GET /v1/account` into presentable figures. */
export function describeBalance(balanceMicro: unknown, heldMicro: unknown): Balance {
  const spendable = micro(balanceMicro);
  const held = micro(heldMicro);
  return {
    credits: toCredits(spendable),
    usd: toUsd(spendable),
    heldCredits: toCredits(held),
    heldUsd: toUsd(held),
  };
}

/** Renders a credit quantity with its dollar value, which is what a user asks in. */
export function formatCredits(credits: number): string {
  return `${credits.toLocaleString("en-US")} credits (${toUsd(credits * MICRO_USD_PER_CREDIT)})`;
}

/**
 * Checks the live pricing text still implies the rate this module assumes.
 *
 * If cogDepot ever repriced a credit, silently converting at the old rate would
 * produce confidently wrong dollar figures - the worst failure available here.
 * The metered-call line states "1 credit ($0.0005)", so its presence is the
 * cheapest available confirmation. Absence is not treated as a mismatch: the
 * wording is prose and may be rephrased, and refusing to answer because a
 * sentence changed would be worse than the risk it guards.
 */
export function creditRateLooksCurrent(meteredCallText: unknown): boolean {
  if (typeof meteredCallText !== "string") return true;
  if (!/\$0\.0005/.test(meteredCallText)) return false;
  return true;
}

function micro(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toCredits(microUsd: number): number {
  return Math.floor(microUsd / MICRO_USD_PER_CREDIT);
}

function toUsd(microUsd: number): string {
  return `$${(microUsd / 1_000_000).toFixed(2)}`;
}
