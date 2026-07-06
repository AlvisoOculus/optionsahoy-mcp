// AlphaLatitude Inc. © 2026
//
// POST /api/v1/protective-put - protective put, zero-cost collar, and put spread pricing.

import { calculateProtectivePut } from '../../../lib/calc/protectivePut';
import { runCalc, type PagesFunction } from '../../_lib/api';
import { parseProtectivePutInput } from '../../_lib/calc-parsers';

export const onRequest: PagesFunction = async (ctx) =>
  runCalc(ctx, 'rest:protective-put', parseProtectivePutInput, calculateProtectivePut);
