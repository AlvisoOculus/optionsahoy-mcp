// AlphaLatitude Inc. © 2026
//
// The adapter between a fetched option chain and the protective-put engine's
// inputs: which strike we ask the chain about, in which units, and what the
// chain contributes besides sigma.
//
// ── Why this is its own module and not four lines in the parser ──────────
// It is a PORT, like ./chainPricing next door. The production chain-driven
// calculator in the sibling repo (optionsahoy_web/web/components/tools/
// ProtectivePutCalculator.tsx, `ivLookup` + `computedInputs`) has built these
// exact fields for months, and MCP has to build them the same way or the two
// surfaces quote different premiums for the same hedge on the same chain.
//
// The interpolator is pinned by golden numbers produced from the sibling's own
// implementation (tests/chain-pricing-golden.test.ts). The layer AROUND it is
// where two independent implementations actually diverge - which strike is
// queried, and whether an argument is in per-share or position dollars - so it
// is pinned by the same goldens rather than by prose. That is only possible if
// it is a pure function of (chain, request, today), which is what this file is:
// the parser owns "is there a chain", this owns "what does it say".

import { chainImpliedVol } from './chainPricing';
import type { TickerChain } from './chains';

/** The engine-input fields a chain can fill. Deliberately a subset of
 *  ProtectivePutInputs rather than the whole thing: everything else on that
 *  type is the caller's own stated fact, and this module must not be able to
 *  overwrite one. */
export type ChainHedgePricing = {
  /** Sigma for the floor put: the implied volatility at the strike this tool
   *  is actually pricing, NOT at the money. That difference is the feature. */
  volatility: number;
  /** Sigma at any other strike the engine solves for, in POSITION dollars. */
  ivAtStrike: (strike: number) => number | null;
  /** The chain's trailing annualized return, when it carries one. Absent for a
   *  recent listing, whose window is shorter than the producer will annualize. */
  expectedReturn?: number;
};

export type ChainHedgeRequest = {
  protectionLevel: number;
  tenorYears: number;
  positionValue: number;
  /** Injectable for tests and goldens; production always uses the server
   *  clock. It sets the tenors of the interpolated surface, so a pinned date is
   *  what makes a golden number reproducible. */
  today?: Date;
};

/**
 * Everything the chain contributes to one hedge quote, or null when it cannot
 * price the leg being asked about (no usable put cells near the floor strike).
 *
 * Null is not a partial answer on purpose: if the surface cannot price the put
 * the caller asked for, it does not get to price the spread's legs either. The
 * caller falls back to flat pricing whole, and says so.
 */
export function chainHedgePricing(
  chain: TickerChain,
  { protectionLevel, tenorYears, positionValue, today }: ChainHedgeRequest,
): ChainHedgePricing | null {
  // The put actually being priced: the floor strike, PER SHARE. Derived from
  // chain.spot and not from the position value, exactly as web derives it, so
  // a $5k position and a $5M position on one ticker price at one sigma. Going
  // via position units instead would round-trip through a division and could
  // land a bit off the strike web queried.
  const atFloor = chainImpliedVol(chain, chain.spot * (1 - protectionLevel), tenorYears, 'P', today);
  if (atFloor === null) return null;

  // Strike arguments reaching ivAtStrike are POSITION-LEVEL dollars (the engine
  // works in position units), so rescale to per-share before hitting the chain.
  // Clamped denominator exactly as web clamps it, so a zero position degrades
  // the same way on both surfaces instead of dividing by zero.
  const pv = Math.max(positionValue, 1);
  const out: ChainHedgePricing = {
    volatility: atFloor.sigma,
    ivAtStrike: (strike: number) =>
      chainImpliedVol(chain, (chain.spot * strike) / pv, tenorYears, 'P', today)?.sigma ?? null,
  };

  const trailing = chain.historicalReturn;
  if (typeof trailing === 'number' && Number.isFinite(trailing)) out.expectedReturn = trailing;
  return out;
}
