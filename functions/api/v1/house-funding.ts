// AlphaLatitude Inc. © 2026
//
// POST /api/v1/house-funding — minimum-tax sell schedule to net a target
// after-tax dollar amount from existing stock lots by a target date.

import { computeHouseFundingPlan } from '../../../lib/calc/houseFunding';
import { runCalc, type PagesFunction } from '../../_lib/api';
import { parseHouseFundingInput } from '../../_lib/calc-parsers';

export const onRequest: PagesFunction = async (ctx) =>
  runCalc(ctx, 'rest:house-funding', parseHouseFundingInput, computeHouseFundingPlan);
