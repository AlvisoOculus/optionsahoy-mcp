// AlphaLatitude Inc. © 2026
//
// POST /api/v1/equity-funding — minimum-tax sell schedule to net a target
// after-tax dollar amount from existing stock lots by a target date.

import { computeEquityFundingPlan } from '../../../lib/calc/equityFunding';
import { runCalc, type PagesFunction } from '../../_lib/api';
import { parseEquityFundingInput } from '../../_lib/calc-parsers';

export const onRequest: PagesFunction = async (ctx) =>
  runCalc(ctx, 'rest:equity-funding', parseEquityFundingInput, computeEquityFundingPlan);
