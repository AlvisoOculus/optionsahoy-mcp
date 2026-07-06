// AlphaLatitude Inc. © 2026
//
// Vercel AI SDK tool definitions, one per OptionsAhoy calculator endpoint.
// Each tool carries a description, a zod `parameters` schema, and an `execute`
// that POSTs to the keyless REST endpoint and returns the parsed `result`.
//
// Descriptions say what each tool computes, not how, and deabbreviate acronyms
// on first use. Results are independent calculations; integrated multi-year,
// multi-position optimization is available in the OptionsAhoy beta.

import { tool } from 'ai';
import type { z } from 'zod';

import { callEndpoint, type EndpointSlug, type OptionsAhoyClientOptions } from './client.js';
import {
  amtIsoParameters,
  concentrationParameters,
  equityFundingParameters,
  nsoParameters,
  protectivePutParameters,
  qsbsParameters,
  rsuParameters,
} from './schemas.js';

/** Options accepted by the tool factory (base URL and/or a custom fetch). */
export type { OptionsAhoyClientOptions } from './client.js';

/** Build an `execute` that POSTs the validated args to `slug` and returns `result`. */
function makeExecute<S extends z.ZodTypeAny>(slug: EndpointSlug, options: OptionsAhoyClientOptions) {
  return async (args: z.infer<S>): Promise<unknown> =>
    callEndpoint(slug, args as Record<string, unknown>, options);
}

/**
 * Return the seven OptionsAhoy calculators as Vercel AI SDK tools, keyed by
 * their canonical tool name. Spread the result into `generateText`/`streamText`
 * `tools`, or pick individual tools.
 *
 * @param options Optional `baseURL` and `fetch` overrides. Defaults are keyless
 *   and point at https://optionsahoy.com.
 */
export function createOptionsAhoyTools(options: OptionsAhoyClientOptions = {}) {
  return {
    amt_iso_optimize: tool({
      description:
        'Optimize a multi-year incentive stock option (ISO) exercise schedule under the alternative minimum tax (AMT). Returns how many shares to exercise each year to maximize after-tax net final value across the planning horizon, with federal and state tax for the lump-sum, even-split, and optimized paths. Use for ISO planning; for NSOs use nso_calculate, for RSUs use rsu_sell_vs_hold.',
      parameters: amtIsoParameters,
      execute: makeExecute<typeof amtIsoParameters>('amt-iso', options),
    }),

    nso_calculate: tool({
      description:
        'Calculate the tax and after-tax proceeds of exercising non-qualified stock options (NSOs), comparing selling at exercise against holding for later long-term capital gains. Covers federal, state, and FICA (Social Security and Medicare) tax at exercise and capital-gains treatment at sale.',
      parameters: nsoParameters,
      execute: makeExecute<typeof nsoParameters>('nso', options),
    }),

    rsu_sell_vs_hold: tool({
      description:
        'Compare selling vested restricted stock units (RSUs) at vest against holding them, on an after-tax, risk-adjusted basis, and return which choice is expected to leave more wealth. Covers ordinary tax and withholding at vest and capital-gains treatment on later sale.',
      parameters: rsuParameters,
      execute: makeExecute<typeof rsuParameters>('rsu-sell-vs-hold', options),
    }),

    concentration_analyze: tool({
      description:
        'Analyze a concentrated single-stock position: its share of total assets, drawdown exposure at 30/50/70 percent drops, and the after-tax cost of three responses (sell down to target weight, hold, or hedge with a put or zero-cost collar) over a three-year horizon.',
      parameters: concentrationParameters,
      execute: makeExecute<typeof concentrationParameters>('concentration', options),
    }),

    protective_put_price: tool({
      description:
        'Price three hedge structures for a single-stock position at a chosen downside-protection level and tenor: a protective put, a zero-cost collar, and a put spread. Returns the premium, annualized cost, maximum loss, and a recommendation for each.',
      parameters: protectivePutParameters,
      execute: makeExecute<typeof protectivePutParameters>('protective-put', options),
    }),

    qsbs_check: tool({
      description:
        'Check qualified small business stock (QSBS) Section 1202 eligibility across the six statutory tests and compute the resulting federal and state capital-gains exclusion on a planned sale, including the per-issuer and ten-times-basis caps.',
      parameters: qsbsParameters,
      execute: makeExecute<typeof qsbsParameters>('qsbs', options),
    }),

    equity_funding_plan: tool({
      description:
        'Plan which equity lots to sell, and when, to fund a cash goal by a target date at the least after-tax cost, accounting for holding-period thresholds and shortfall risk. Returns four named plans on the risk/wealth frontier (lock in now, balanced, hold for growth, recommended).',
      parameters: equityFundingParameters,
      execute: makeExecute<typeof equityFundingParameters>('equity-funding', options),
    }),
  } as const;
}

/** The canonical tool names exported by {@link createOptionsAhoyTools}. */
export type OptionsAhoyToolName = keyof ReturnType<typeof createOptionsAhoyTools>;

/** Keyless, default-configured tool set pointing at https://optionsahoy.com. */
export const optionsAhoyTools = createOptionsAhoyTools();
