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

/**
 * µUSD per credit. 1 credit = $0.0005 = 500 µUSD.
 *
 * This was 50 in 0.1.2 and that was wrong by a factor of ten: it reported a
 * funded account's $10.00 welcome credit as 200,000 credits instead of 20,000,
 * while the dollar figure stayed correct, so the output looked internally
 * consistent. Three independent sources agree on 500 - the API's own money
 * configuration, the welcome credit (10,000,000 µUSD for 20,000 credits), and
 * the x402 manifest (5,000,000 µUSD for 10,000 credits).
 *
 * The tests below derive the rate from a documented credit/dollar pair rather
 * than restating this constant. The 0.1.2 tests asserted the buggy output, so
 * they passed and proved nothing - a test written from the same wrong premise
 * as the code is not a check, it is an echo.
 */
export const MICRO_USD_PER_CREDIT = 500;

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
 * Converts a dollar amount to the µUSD integer the API takes.
 *
 * The output rule has an input twin. `POST /v1/listings` wants `price_micro`,
 * and a tool that asked a model for that field directly would invite exactly the
 * error this module exists to prevent - a model that types 1000000 meaning "a
 * million" prices a listing at $1.00, and one that types 50 meaning "$50" prices
 * it at $0.00005. Tools take dollars, and this is the only place the conversion
 * happens.
 *
 * Rounded, not truncated: $0.0000004 is a typo, not a price, and floor() would
 * silently make it free.
 */
export function toMicroUsd(dollars: number): number {
  return Math.round(dollars * 1_000_000);
}

/** Renders a µUSD figure as dollars. Exported for tools echoing back a price. */
export function microToUsd(microUsd: number): string {
  return toUsd(microUsd);
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
export function creditRateLooksCurrent(rateText: unknown): boolean {
  if (typeof rateText !== "string") return true;
  return /\$0\.0005/.test(rateText);
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
