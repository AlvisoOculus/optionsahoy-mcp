// AlphaLatitude Inc. © 2026
//
// POST /api/v1/nso — NSO exercise tax + sell-vs-hold comparison.

import { computeNsoResult } from '../../../lib/calc/nso';
import { runCalc, type PagesFunction } from '../../_lib/api';
import { parseNsoInput } from '../../_lib/calc-parsers';

export const onRequest: PagesFunction = async (ctx) =>
  runCalc(ctx, 'rest:nso', parseNsoInput, computeNsoResult);
