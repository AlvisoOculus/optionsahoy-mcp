// AlphaLatitude Inc. © 2026
//
// POST /api/v1/equity-funding: multi-plan equity-funding comparison.
// Returns Lock-in-now / Balanced / Hold-for-growth / Recommended plus the
// full hybrid frontier. Wraps computeEquityFundingComparison.

import { computeEquityFundingComparison } from '../../../lib/calc/equityFunding';
import { runCalc, type PagesFunction } from '../../_lib/api';
import { parseEquityFundingInput } from '../../_lib/calc-parsers';

export const onRequest: PagesFunction = async (ctx) =>
  runCalc(ctx, 'rest:equity-funding', parseEquityFundingInput, computeEquityFundingComparison);
